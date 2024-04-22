import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startMocks } from './helpers/setup.js';

let mocks;
before(async () => {
  mocks = await startMocks();
});
after(() => mocks.close());
beforeEach(() => {
  mocks.reset();
  Object.assign(mocks.faults, { enrich: 0, crm: 0, slack: 0 });
});

const crm = (body, key = 'mock-crm-key') =>
  fetch(`${mocks.baseUrl}/crm/v1/contacts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const enrich = (domain, key = 'mock-enrich-key') =>
  fetch(`${mocks.baseUrl}/enrich/v1/companies?domain=${encodeURIComponent(domain)}`, { headers: { 'x-api-key': key } });
const slack = (channel, body, type = 'application/json') =>
  fetch(`${mocks.baseUrl}/slack/hooks/${channel}`, { method: 'POST', headers: { 'content-type': type }, body });

test('enrichment: known domain, unknown domain, bad key, missing domain', async () => {
  const ok = await enrich('BrightLabs.io');
  assert.equal(ok.status, 200);
  assert.deepEqual(
    { ...(await ok.json()), techStack: undefined, linkedin: undefined },
    { domain: 'brightlabs.io', name: 'Bright Labs', industry: 'SaaS', employees: 85, employeesRange: '50-199',
      country: 'GB', city: 'London', techStack: undefined, linkedin: undefined },
  );
  assert.equal((await enrich('nobody.example')).status, 404);
  assert.equal((await enrich('brightlabs.io', 'wrong')).status, 401);
  assert.equal((await enrich('')).status, 400);
});

test('crm: creates, then updates by email without losing fields', async () => {
  const first = await crm({ email: 'A@B.com', firstName: 'A', phone: '+1555', source: 'google' });
  assert.equal(first.status, 201);
  const created = await first.json();
  assert.equal(created.created, true);
  assert.equal(created.contact.email, 'a@b.com');

  const second = await crm({ email: 'a@b.com', firstName: 'Ann', phone: '', source: 'linkedin' });
  assert.equal(second.status, 200);
  const updated = await second.json();
  assert.equal(updated.id, created.id);
  assert.equal(updated.contact.firstName, 'Ann');
  assert.equal(updated.contact.phone, '+1555');
  assert.equal(updated.contact.source, 'google');
  assert.equal(updated.contact.latestSource, 'linkedin');
  assert.equal(updated.contact.submissions, 2);
});

test('crm: rejects bad auth, bad JSON and a missing email', async () => {
  assert.equal((await crm({ email: 'a@b.com' }, 'nope')).status, 401);
  assert.equal((await crm('{not json')).status, 400);
  assert.equal((await crm({ firstName: 'x' })).status, 422);
  assert.equal(mocks.state.contacts.size, 0);
});

test('slack: accepts text or blocks, answers like Slack does', async () => {
  const ok = await slack('sales-hot', JSON.stringify({ text: 'hi' }));
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ok');
  const form = await slack('sales-hot', `payload=${encodeURIComponent(JSON.stringify({ text: 'form' }))}`, 'application/x-www-form-urlencoded');
  assert.equal(form.status, 200);
  assert.equal(await (await slack('sales-hot', JSON.stringify({}))).text(), 'no_text');
  assert.equal(await (await slack('sales-hot', 'nope')).text(), 'invalid_payload');
  assert.deepEqual(mocks.state.messages.map((m) => [m.channel, m.text]), [['#sales-hot', 'hi'], ['#sales-hot', 'form']]);
});

test('fault injection makes a service answer 503, and can be switched off again', async () => {
  const set = (faults) =>
    fetch(`${mocks.baseUrl}/_mock/faults`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(faults) });
  assert.deepEqual((await (await set({ crm: 1, enrich: 7 })).json()).faults, { enrich: 1, crm: 1, slack: 0 });
  assert.equal((await crm({ email: 'a@b.com' })).status, 503);
  assert.equal((await enrich('brightlabs.io')).status, 503);
  await set({ crm: 0, enrich: 0 });
  assert.equal((await crm({ email: 'a@b.com' })).status, 201);
});

test('dashboard state lists newest contacts first', async () => {
  await crm({ email: 'old@b.com' });
  await new Promise((r) => setTimeout(r, 5));
  await crm({ email: 'new@b.com' });
  const state = await (await fetch(`${mocks.baseUrl}/api/state`)).json();
  assert.deepEqual(state.contacts.map((c) => c.email), ['new@b.com', 'old@b.com']);
  assert.equal(state.requests.crm, 2);
});

test('serves the dashboard and the form, 404s elsewhere, and limits body size', async () => {
  for (const page of ['/', '/form']) {
    const res = await fetch(mocks.baseUrl + page);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
  }
  assert.equal((await fetch(`${mocks.baseUrl}/nope`)).status, 404);
  assert.equal((await crm({ email: 'a@b.com', message: 'x'.repeat(200_000) })).status, 413);
});

function exportCsv(data) {
  if (!data) return null;
  return data;
}

function detectLanguage(data) {
  if (!data) return null;
  return data;
}

function runMigration(data) {
  if (!data) return null;
  return data;
}

function exportCsv(data) {
  if (!data) return null;
  return data;
}

function extractText(data) {
  if (!data) return null;
  return data;
}