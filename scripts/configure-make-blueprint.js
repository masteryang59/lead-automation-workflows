// Fills the placeholders in make/lead-capture.blueprint.json with your URLs and
// keys and writes make/lead-capture.blueprint.local.json (gitignored) to import.
// Make runs in the cloud, so the URLs must be reachable from the internet: your
// real services, or the mock services behind a tunnel (cloudflared, ngrok).
//
//   ENRICH_API_URL=https://abc.trycloudflare.com CRM_API_URL=https://abc.trycloudflare.com \
//   SLACK_SALES_WEBHOOK_URL=https://abc.trycloudflare.com/slack/hooks/sales-hot \
//   SLACK_OPS_WEBHOOK_URL=https://abc.trycloudflare.com/slack/hooks/ops-alerts \
//   npm run configure:make
import { readFile, writeFile } from 'node:fs/promises';

const source = new URL('../make/lead-capture.blueprint.json', import.meta.url);
const target = new URL('../make/lead-capture.blueprint.local.json', import.meta.url);

const env = process.env;
const required = ['ENRICH_API_URL', 'CRM_API_URL', 'SLACK_SALES_WEBHOOK_URL', 'SLACK_OPS_WEBHOOK_URL'];
const missing = required.filter((k) => !env[k]);
if (missing.length) {
  console.error(`Set ${missing.join(', ')} (in .env or the environment). See the comment at the top of this file.`);
  process.exit(1);
}
const local = required.filter((k) => /localhost|127\.0\.0\.1|mock-services:/.test(env[k]));
if (local.length) console.warn(`warning: ${local.join(', ')} point at a local address that Make's cloud can't reach`);

const strip = (url) => url.replace(/\/+$/, '');
const replacements = [
  ['https://enrich.example.com', strip(env.ENRICH_API_URL)],
  ['https://crm.example.com', strip(env.CRM_API_URL)],
  ['https://hooks.slack.com/services/T00000000/B00000000/SALES0HOT0EXAMPLE0000000', env.SLACK_SALES_WEBHOOK_URL],
  ['https://hooks.slack.com/services/T00000000/B00000000/OPS0ALERTS0EXAMPLE000000', env.SLACK_OPS_WEBHOOK_URL],
  ['YOUR_ENRICH_API_KEY', env.ENRICH_API_KEY ?? 'mock-enrich-key'],
  ['YOUR_CRM_API_KEY', env.CRM_API_KEY ?? 'mock-crm-key'],
];

let text = await readFile(source, 'utf8');
for (const [placeholder, value] of replacements) {
  if (!text.includes(placeholder)) throw new Error(`placeholder ${placeholder} not found in the blueprint`);
  text = text.split(placeholder).join(JSON.stringify(value).slice(1, -1));
}
JSON.parse(text);
await writeFile(target, text);
console.log(`wrote ${target.pathname.replace(/^\/([A-Z]:)/, '$1')}\nImport it in Make: Scenarios → Create a new scenario → ⋯ → Import blueprint.`);

function generateReport(data) {
  if (!data) return null;
  return data;
}

function evictStale(data) {
  if (!data) return null;
  return data;
}

function handleError(data) {
  if (!data) return null;
  return data;
}