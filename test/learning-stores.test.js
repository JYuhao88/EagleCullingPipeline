import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import { FeatureStore, contentHash } from '../src/core/feature-store.js';
import { EventLog } from '../src/core/event-log.js';
import { LearningData, PROTECTED_LEARNING_LIBRARY } from '../src/core/learning-data.js';
import { PixelRetention } from '../src/core/pixel-retention.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'learning-stores-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.jpg');
  await sharp({ create: { width: 640, height: 600, channels: 3, background: '#abc' } }).jpeg().toFile(source);
  const other = path.join(root, 'other.jpg');
  await sharp({ create: { width: 640, height: 600, channels: 3, background: '#cba' } }).jpeg().toFile(other);
  const data = { run: { id: 'r1', libraryPath: PROTECTED_LEARNING_LIBRARY },
    units: [{ id: 'a', primaryItemId: 'i1', itemIds: ['i1'] }, { id: 'b', primaryItemId: 'i2', itemIds: ['i2'] }],
    items: [{ id: 'i1', path: source, exif: { ISO: 100 } }, { id: 'i2', path: other }],
    results: [{ unitId: 'a', fingerprint: 'fp1', embedding: [0.1, 0.2], metrics: { sharpness: 0.8, quality: null }, faces: [] },
      { unitId: 'b', fingerprint: 'fp2', metrics: { sharpness: 0.9 } }],
    groups: [{ id: 'g1', unitIds: ['a', 'b'],
      ranking: [{ unitId: 'b', rank: 1, score: 0.9 }, { unitId: 'a', rank: 2, score: 0.8 }],
      suggested: { a: 'candidate', b: 'selected' } }] };
  return { root, source, other, data };
}

test('feature store preserves content identity across runs and source deletion; absent measurements are na', async t => {
  const { root, source, data } = await fixture(t);
  const learning = new LearningData(root);
  const first = await learning.ingestRun(data), hash = first.get('a');
  assert.equal(hash, await contentHash(source));
  const feature = await learning.features.get(hash);
  assert.equal(feature.metrics.focus, 'na'); assert.equal(feature.metrics.quality, 'na');
  assert.deepEqual(feature.embedding, [0.1, 0.2]); assert.equal(feature.exif.ISO, 100);
  const second = await learning.ingestRun({ ...data, run: { ...data.run, id: 'r2' } });
  assert.equal(second.get('a'), hash);
  assert.equal((await learning.features.get(hash)).contexts.length, 2);
  await rm(source);
  assert.deepEqual((await new FeatureStore(root).get(hash)).embedding, feature.embedding);
  assert.equal((await new LearningData(root).ingestRun(data)).get('a'), hash);
  await assert.rejects(learning.features.get('../invalid'), /Invalid content/);
});

test('old run proxy fallback explicitly labels proxy content without inventing missing embedding', async t => {
  const { root, source } = await fixture(t);
  const store = new FeatureStore(root);
  const feature = await store.fromResult({ unitId: 'legacy', previewPath: source, metrics: {} });
  assert.equal(feature.identity.kind, 'proxy'); assert.equal(feature.embedding, 'na');
  assert.equal(await store.fromResult({ unitId: 'missing', metrics: {} }), null);
});

test('event log only appends, serializes concurrent events and surfaces corrupted history', async t => {
  const { root } = await fixture(t); const log = new EventLog(root);
  await Promise.all(Array.from({ length: 20 }, (_, index) => log.append({ type: 'exposure', index })));
  assert.equal((await log.read()).length, 20);
  const before = await readFile(log.file, 'utf8');
  await log.append({ type: 'decision' });
  assert.ok((await readFile(log.file, 'utf8')).startsWith(before));
  await writeFile(log.file, '{broken}\n'); await assert.rejects(log.read());
});

test('review snapshot provenance, bulk weak signals, undo and historical backfill do not change decisions', async t => {
  const { root, data } = await fixture(t); const learning = new LearningData(root);
  const decisions = [{ unitId: 'a', action: 'selected', source: 'human', tie: true,
    category: 'candidate', reason: 'dark', updatedAt: '2026-01-01T00:00:00Z' }];
  const original = JSON.stringify(decisions);
  const [event] = await learning.recordDecisions(data, decisions);
  assert.equal(event.signal, 'corrected'); assert.equal(event.tie, true); assert.equal(event.reason, 'dark');
  assert.equal(event.candidateHashes.length, 2); assert.equal(event.winners.length, 1);
  assert.deepEqual(await learning.recordDecisions(data, decisions), []);
  const [undo] = await learning.recordDecisions(data, []);
  assert.equal(undo.type, 'undo'); assert.equal(undo.targetEventId, event.id); assert.deepEqual(undo.winners, []);
  const [bulk] = await learning.recordDecisions(data, decisions, { signal: 'bulk' }); assert.equal(bulk.signal, 'bulk');
  const [historical] = await learning.backfill({ ...data, run: { ...data.run, id: 'old' } }, decisions);
  assert.equal(historical.timestamp, decisions[0].updatedAt); assert.equal(historical.provenance, 'historical-decisions');
  assert.equal(historical.exposureKnown, false); assert.equal(JSON.stringify(decisions), original);
  const exposure = await learning.recordExposure(data, 'g1', {
    unitIds: ['a', 'b'], visibleUnitIds: ['a'], aiVisible: false, queryPolicy: 'alternating-control' });
  assert.equal(exposure.aiVisible, false); assert.equal(exposure.display[0].inViewport, true);
  assert.equal(exposure.display[1].inViewport, false); assert.equal(exposure.queryPolicy, 'alternating-control');
  await assert.rejects(learning.recordExposure(data, 'g1', { unitIds: ['outside'] }), /non-member/);
});

test('deletion detection requires protected complete read-only inventory and emits idempotent tombstone', async t => {
  const { root, data, source } = await fixture(t); const learning = new LearningData(root);
  const hashes = await learning.ingestRun(data), before = await contentHash(source);
  const inventory = { libraryPath: PROTECTED_LEARNING_LIBRARY, activeLibraryPath: PROTECTED_LEARNING_LIBRARY,
    liveItemIds: ['i2'], complete: true };
  await assert.rejects(learning.detectDeletions({ ...inventory, complete: false }), /complete inventory/);
  await assert.rejects(learning.detectDeletions({ ...inventory, activeLibraryPath: '/other' }), /complete inventory/);
  const [deleted] = await learning.detectDeletions(inventory);
  assert.equal(deleted.hash, hashes.get('a')); assert.equal(deleted.strength, 'strong-negative');
  assert.deepEqual(await learning.detectDeletions(inventory), []);
  assert.equal((await learning.features.get(hashes.get('a'))).availability.original, false);
  assert.equal(await contentHash(source), before);
});

test('pixel tier 0 creates no pixel files; opt-in tier 1 preserves native crops and unchanged original', async t => {
  const { root, source } = await fixture(t); const pixels = new PixelRetention(root), hash = await contentHash(source);
  assert.deepEqual(await pixels.retain(hash), { tier: 0, files: [], reason: 'features-only' });
  await assert.rejects(access(path.join(root, 'pixels')));
  const manifest = await pixels.retain(hash, { tier: 1, sourcePath: source, retentionDays: 30 });
  assert.equal(manifest.files.length, 3); assert.ok(manifest.expiresAt);
  const overview = await sharp(manifest.files[0].file).metadata(); assert.equal(overview.width, 640);
  const crop = await sharp(manifest.files[1].file).metadata(); assert.equal(crop.width, 512); assert.equal(crop.height, 512);
  assert.equal(await contentHash(source), hash);
  await assert.rejects(pixels.retain(hash, { tier: 2 }), /Only retention tiers/);
});
