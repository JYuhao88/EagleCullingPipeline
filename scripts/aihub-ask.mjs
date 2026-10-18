// One cached, budgeted structured call to the AIHub chat endpoint. Every billed response is appended to the
// cache's ledger, and an identical request is answered from it without another call.
import { createHash } from 'node:crypto';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const digest = value => createHash('sha256').update(value).digest('hex');

export async function ask({ model, budget, messages, schema, cache, name = 'advice_check', maxTokens = 2048 }) {
  const ledgerFile = path.join(cache, 'ledger.jsonl');
  const events = await readFile(ledgerFile, 'utf8').then(text => text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)),
    error => { if (error.code === 'ENOENT') return []; throw error; });
  const teacher = await readFile(path.join(ROOT, 'data/cache/teacher/ledger.jsonl'), 'utf8');
  const price = teacher.trim().split('\n').map(line => JSON.parse(line))
    .find(event => event.model === model && event.pricing)?.pricing;
  if (!price) throw new Error('No saved unit price for the selected model');
  const rate = Number(price.usdToCny);
  const cost = usage => ((usage.prompt_tokens * price.input) + (usage.completion_tokens * price.output)) / 1e6 * rate;
  const spent = events.filter(event => event.type === 'response').reduce((sum, event) => sum + event.costCny, 0);
  const parts = messages.map(part => part.type === 'image_url' ? digest(part.image_url.url) : part.text);
  const requestId = digest(JSON.stringify({ model, messages: parts, schema }));
  const cached = events.findLast(event => event.requestId === requestId && event.type === 'response' && event.valid);
  if (cached) return cached.result;
  const estimate = cost({ prompt_tokens: messages.some(part => part.type === 'image_url') ? 16000 : 1200,
    completion_tokens: 800 });
  if (spent + estimate > budget) throw new Error('Budget reached');
  const url = process.env.ECP_AIHUB_URL, key = process.env.ECP_AIHUB_KEY;
  if (!url || !key) throw new Error('Missing AIHub environment');
  const response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(180000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, max_completion_tokens: maxTokens, messages: [{ role: 'user', content: messages }],
      response_format: { type: 'json_schema', json_schema: { name, schema } } }) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = await response.json();
  const usage = { prompt_tokens: body.usage?.prompt_tokens || 0, completion_tokens: body.usage?.completion_tokens || 0 };
  let result = null;
  try { result = JSON.parse(body.choices?.[0]?.message?.content); } catch { /* billed below */ }
  const event = { type: 'response', requestId, model, pricing: { input: price.input, output: price.output, usdToCny: rate },
    usage, costCny: cost(usage), valid: Boolean(result), result, at: new Date().toISOString() };
  const handle = await open(ledgerFile, 'a', 0o600);
  await handle.writeFile(JSON.stringify(event) + '\n'); await handle.sync(); await handle.close();
  if (!result) throw new Error('Invalid model JSON');
  return result;
}

export async function spentCny(cache) {
  const text = await readFile(path.join(cache, 'ledger.jsonl'), 'utf8').catch(() => '');
  return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.type === 'response').reduce((sum, event) => sum + event.costCny, 0);
}
