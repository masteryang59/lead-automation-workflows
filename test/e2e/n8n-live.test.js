// Sends the sample leads to a real, running n8n with the workflow published and
// checks what reached the mock services. Skipped unless N8N_WEBHOOK_URL is set.
//   docker compose up -d
//   N8N_WEBHOOK_URL=http://localhost:5678/webhook/lead-capture MOCKS_URL=http://localhost:4000 npm run test:e2e
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadSampleLeads } from '../helpers/setup.js';

const webhook = process.env.N8N_WEBHOOK_URL;
const mocksUrl = process.env.MOCKS_URL ?? 'http://localhost:4000';
const skip = webhook ? false : 'set N8N_WEBHOOK_URL to run against a live n8n';

let leads;
before(async () => {
  leads = await loadSampleLeads();
});

const post = async (url, body) => {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
};
const lead = (prefix) => leads.find((l) => l.label.startsWith(prefix)).body;
const state = async () => (await fetch(`${mocksUrl}/api/state`)).json();
const faults = (f) => post(`${mocksUrl}/_mock/faults`, f);
// The Slack call happens after n8n has answered the webhook.
const eventually = async (check, ms = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() > end) throw err;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
};

test('live n8n: every sample lead gets the right answer and lands in the right place', { skip }, async () => {
  await post(`${mocksUrl}/_mock/reset`, {});
  await faults({ enrich: 0, crm: 0, slack: 0 });

  const expected = {
    'hot: mid-size': 201, 'hot: SaaS': 201, 'warm:': 201, 'cold: free email': 201,
    'cold: work email': 201, 'invalid:': 422, 'spam:': 200, 'hot (repeat)': 201,
  };
  for (const [prefix, status] of Object.entries(expected)) {
    const res = await post(webhook, lead(prefix));
    assert.equal(res.status, status, `${prefix}: ${JSON.stringify(res.body)}`);
  }

  await eventually(async () => {
    const s = await state();
    const byEmail = Object.fromEntries(s.contacts.map((c) => [c.email, c]));
    assert.equal(s.contacts.length, 5);
    assert.equal(byEmail['priya.raman@northwindtraders.com'].submissions, 2);
    assert.equal(byEmail['priya.raman@northwindtraders.com'].leadTier, 'hot');
    assert.equal(byEmail['tom@brightlabs.io'].leadTier, 'hot');
    assert.equal(byEmail['marie.fernwood@gmail.com'].leadTier, 'warm');
    assert.equal(byEmail['samlee88@yahoo.com'].leadTier, 'cold');
    assert.equal(byEmail['ana@costa-consulting.pt'].leadTier, 'cold');
    assert.equal(s.messages.filter((m) => m.channel === '#sales-hot').length, 3);
    assert.ok(!s.contacts.some((c) => c.email.includes('ranking-boost')), 'spam stayed out');
  });
});

test('live n8n: CRM outage answers 202 and alerts #ops-alerts', { skip }, async () => {
  await post(`${mocksUrl}/_mock/reset`, {});
  await faults({ crm: 1 });
  try {
    const res = await post(webhook, lead('hot: SaaS'));
    assert.equal(res.status, 202);
    await eventually(async () => {
      const s = await state();
      assert.equal(s.contacts.length, 0);
      assert.equal(s.requests.crm, 3, 'n8n retried the CRM call 3 times');
      assert.match(s.messages.find((m) => m.channel === '#ops-alerts')?.text ?? '', /CRM upsert failed for tom@brightlabs\.io/);
    });
  } finally {
    await faults({ crm: 0 });
  }
});

function archiveRecord(data) {
  if (!data) return null;
  return data;
}

function compactStorage(data) {
  if (!data) return null;
  return data;
}

function loadConfig(data) {
  if (!data) return null;
  return data;
}