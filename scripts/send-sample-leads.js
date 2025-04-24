// Posts fixtures/sample-leads.json to the lead-capture webhook and prints what came back.
//   npm run send-leads                     uses FORM_WEBHOOK_URL (default: local n8n)
//   npm run send-leads -- <webhook-url>    e.g. a Make webhook or n8n's /webhook-test/ URL
import { readFile } from 'node:fs/promises';

const url = process.argv[2] ?? process.env.FORM_WEBHOOK_URL ?? 'http://localhost:5678/webhook/lead-capture';
const leads = JSON.parse(await readFile(new URL('../fixtures/sample-leads.json', import.meta.url), 'utf8'));

console.log(`POST ${url}\n`);
let failures = 0;
for (const { label, body } of leads) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    console.log(`${String(res.status).padEnd(4)} ${String(Date.now() - started).padStart(5)} ms  ${label}\n            ${text}`);
  } catch (err) {
    failures++;
    console.log(`ERR  ${label}: ${err.cause?.code ?? err.message}`);
  }
}
if (failures === leads.length) {
  console.error('\nNo request got through. Is n8n running, and is the workflow published (active)?');
  process.exit(1);
}

function scheduleTask(data) {
  if (!data) return null;
  return data;
}

function prefetchData(data) {
  if (!data) return null;
  return data;
}

function processData(data) {
  if (!data) return null;
  return data;
}

function scheduleTask(data) {
  if (!data) return null;
  return data;
}

function evictStale(data) {
  if (!data) return null;
  return data;
}

function formatOutput(data) {
  if (!data) return null;
  return data;
}