#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// Include pending additions too: a clean index alone does not validate a pending release.
const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
const checks = [
  ['internal host', /(?:[\w-]+\.)*(?:oa|woa)\.com\b|star\x2dproxy/i],
  ['private username', /\x66elixjjiang/i],
  ['personal home', /\/Users\//],
  ['windows local path', /\b[A-Z]:[\\/]{1,2}(?:Users|Photography)\b|\b[A-Z]:[\\/][^\s"'`]*\.library\b/i],
  ['cluster storage', /\x74aijifs|\x61pdcephfs|\/mnt\//i],
  ['private corpus release', /\x74aiji_paper|\x64\x34_paper_\w+_\d+_release|provenance_2026\x31009/i],
  ['agent memory or conversation', /\.codex\/(?:memories|sessions)|oai\x2dmem-citation|rollout\x5fsummaries/],
  ['object storage identity', /(?:s3|ceph):\/\/[^\s"'<>]+|gcs:\/\/_ray_pkg_[\w.-]+/i],
  ['credential', /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16})\b/],
  ['cookie value', /\b(?:SESSDATA|bili_jct)=[A-Za-z0-9%_-]{8,}/i],
  ['literal secret', /(?:api[_-]?key|access[_-]?token|password|cookie|authorization)["']?\s*[:=]\s*["'][A-Za-z0-9+/%_=.-]{16,}["']/i],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\b/],
  ['embedded image/video', /data:(?:image|video)\/[^;,]+;base64,[A-Za-z0-9+/]{100}/i],
  ['social profile', /https?:\/\/(?:www\.)?xiaohongshu\.com\/user\/profile\/[^\s"'<>]+/i],
];
const media = /\.(?:jpe?g|png|webp|gif|heic|avif|bmp|tiff?|arw|dng|3fr|cr[23]|nef|raf|orf|rw2|mp4|mov|m4[av]|webm|avi|pdf)$/i;
// Only this reviewed camera icon may contain raster bytes; its digest prevents silent replacement.
const allowedBinary = new Map([['src/plugin/logo.png', {
  sha256: 'f8c7917b7626c342c92370b25b1eae770f77ffaef03b2d1156ebfef0a4a1c79f',
  reason: 'Camera icon, no person/photo/screenshot; explicitly retained for the Eagle plugin.',
}]]);
const issues = [];
const fail = (file, line, reason) => issues.push(`${file}${line ? `:${line}` : ''}: ${reason}`);
let scanned = 0, removed = 0;
function checkEvidence(value, file, location = '$') {
  if (Array.isArray(value)) value.forEach((entry, i) => checkEvidence(entry, file, `${location}[${i}]`));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (['paraphrase', 'quote', 'excerpt', 'abstract'].includes(key) && typeof entry === 'string' && [...entry].length > 40) {
        fail(file, null, `${location}.${key}: evidence exceeds 40 characters`);
      }
      if (key === 'corpusRef' && entry && ('id' in entry || 'channel' in entry)) {
        fail(file, null, `${location}.${key}: private corpus identity`);
      }
      checkEvidence(entry, file, `${location}.${key}`);
    }
  }
}
for (const file of files) {
  const full = path.join(root, file);
  if (!existsSync(full)) { removed++; continue; } // tracked deletions are absent from the squash tree
  scanned++;
  for (const [label, pattern] of checks) if (pattern.test(file)) fail(file, null, `filename ${label}`);
  if (/^(?:data|models|node_modules|exports)\//.test(file) || file === 'config/local.json' || /^\.env(?:\.|$)/.test(file)) {
    fail(file, null, 'local data/config must not be tracked');
  }
  const buffer = readFileSync(full);
  const allowed = allowedBinary.get(file);
  if (allowed) {
    if (createHash('sha256').update(buffer).digest('hex') !== allowed.sha256) fail(file, null, 'binary whitelist digest changed');
    continue;
  }
  if (media.test(file)) fail(file, null, 'image/video/document binary outside whitelist');
  let source;
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { fail(file, null, 'non-text binary outside whitelist'); continue; }
  if (source.includes('\0')) fail(file, null, 'binary NUL outside whitelist');
  source.split('\n').forEach((line, i) => {
    for (const [label, pattern] of checks) if (pattern.test(line)) fail(file, i + 1, label);
    for (const match of line.matchAll(/(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/g)) {
      const ip = match[0];
      // Exact loopback only: local service endpoints and synthetic server tests, no external identity.
      if (ip !== '127.0.0.1' && ip.split('.').every(part => Number(part) <= 255)) fail(file, i + 1, 'non-loopback IPv4');
    }
  });
  if (file.endsWith('.json')) {
    try { checkEvidence(JSON.parse(source), file); }
    catch (error) { fail(file, null, `invalid JSON: ${error.message}`); }
  }
}
for (const issue of issues) console.error(issue);
console.log(JSON.stringify({ scanned, removed, hits: issues.length,
  whitelist: [...allowedBinary].map(([file, entry]) => ({ file, reason: entry.reason })),
  textException: '127.0.0.1: exact loopback for local services and synthetic tests; no whole-file text exemptions.' }, null, 2));
if (issues.length) process.exitCode = 1;
