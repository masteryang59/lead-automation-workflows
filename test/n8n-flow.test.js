// Runs the exported n8n workflow end to end against the mock services.
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { runWorkflow } from './helpers/n8n-runner.js';
import { loadWorkflow, loadDemoCredentials, loadSampleLeads, startMocks } from './helpers/setup.js';

let workflow, credentials, leads, mocks;

before(async () => {
  [workflow, credentials, leads] = await Promise.all([loadWorkflow(), loadDemoCredentials(), loadSampleLeads()]);
  mocks = await startMocks();
});
after(() => mocks.close());
beforeEach(() => {
  mocks.reset();
  Object.assign(mocks.faults, { enrich: 0, crm: 0, slack: 0 });
});

const lead = (labelStart) => leads.find((l) => l.label.startsWith(labelStart)).body;
const submit = (body) => runWorkflow(workflow, { body, env: mocks.env, credentials });
const contacts = () => [...mocks.state.contacts.values()];
const messages = (channel) => mocks.state.messages.filter((m) => m.channel === channel);

test('a hot lead is enriched, scored, saved to the CRM and posted to #sales-hot', async () => {
  const run = await submit(lead('hot: mid-size'));

  assert.equal(run.error, null);
  assert.equal(run.response.status, 201);
  assert.match(run.response.body.leadId, /^ct_/);
  assert.deepEqual(run.executed, [
    'Form submission', 'Normalize & validate', 'Is spam?', 'Valid?', 'Has company domain?',
    'Enrich company', 'Score lead', 'Upsert CRM contact', 'Respond: 201 created', 'Hot lead?',
    'Format Slack alert', 'Notify #sales-hot',
  ]);

  const [contact] = contacts();
  assert.equal(contact.email, 'priya.raman@northwindtraders.com');
  assert.equal(contact.company, 'Northwind Traders', 'enriched name wins over what was typed');
  assert.equal(contact.industry, 'E-commerce');
  assert.equal(contact.employees, 340);
  assert.equal(contact.phone, '+12065550142');
  assert.equal(contact.leadTier, 'hot');
  assert.equal(contact.leadScore, 100);
  assert.equal(contact.source, 'google');
  assert.equal(contact.utmCampaign, 'helpdesk-migration');

  const [slack] = messages('#sales-hot');
  assert.match(slack.text, /Hot lead: Priya Raman at Northwind Traders \(score 100\)/);
  assert.equal(slack.blocks[0].type, 'header');
  assert.ok(JSON.stringify(slack.blocks).includes(contact.id), 'Slack alert links the CRM record');
});

test('the visitor gets their response before the Slack call', async () => {
  const run = await submit(lead('hot: SaaS'));
  assert.ok(run.executed.indexOf('Respond: 201 created') < run.executed.indexOf('Notify #sales-hot'));
});

test('warm and cold leads go to the CRM without a Slack alert', async () => {
  const warm = await submit(lead('warm:'));
  const cold = await submit(lead('cold: free email'));

  assert.equal(warm.response.status, 201);
  assert.equal(cold.response.status, 201);
  assert.ok(!warm.executed.includes('Notify #sales-hot'));
  assert.ok(!cold.executed.includes('Notify #sales-hot'));
  assert.equal(messages('#sales-hot').length, 0);

  const byEmail = Object.fromEntries(contacts().map((c) => [c.email, c]));
  assert.equal(byEmail['marie.fernwood@gmail.com'].leadTier, 'warm');
  assert.equal(byEmail['marie.fernwood@gmail.com'].company, 'Fernwood Bakery', 'free email fell back to the website');
  assert.equal(byEmail['samlee88@yahoo.com'].leadTier, 'cold');
});

test('free-email leads without a website skip the enrichment call', async () => {
  const run = await submit(lead('cold: free email'));
  assert.ok(!run.executed.includes('Enrich company'));
  assert.equal(mocks.state.requests.enrich, 0);
});

test('a company the enrichment API does not know still becomes a lead', async () => {
  const run = await submit(lead('cold: work email'));
  assert.equal(run.response.status, 201);
  const [contact] = contacts();
  assert.equal(contact.company, 'Costa Consulting');
  assert.equal(contact.industry, undefined, 'empty enrichment fields are not written');
  assert.match(contact.scoreReasons, /work email/);
});

test('spam is answered with 200 and goes nowhere', async () => {
  const run = await submit(lead('spam:'));
  assert.deepEqual(run.response, { node: 'Respond: ignore spam', status: 200, body: { ok: true } });
  assert.deepEqual(run.executed, ['Form submission', 'Normalize & validate', 'Is spam?', 'Respond: ignore spam']);
  assert.equal(contacts().length, 0);
  assert.deepEqual(mocks.state.requests, { enrich: 0, crm: 0, slack: 0 });
});

test('an invalid submission gets 422 with every problem listed', async () => {
  const run = await submit(lead('invalid:'));
  assert.equal(run.response.status, 422);
  assert.deepEqual(run.response.body, {
    ok: false,
    errors: ['email is not a valid address', 'consent to be contacted is required'],
  });
  assert.equal(contacts().length, 0);
});

test('when enrichment is down the lead is retried once, then saved unenriched', async () => {
  mocks.faults.enrich = 1;
  const run = await submit(lead('hot: SaaS'));

  assert.equal(run.response.status, 201);
  assert.equal(run.calls.filter((c) => c.node === 'Enrich company').length, 2);
  const [contact] = contacts();
  assert.equal(contact.company, 'Bright Labs');
  assert.equal(contact.leadTier, 'warm', 'without firmographics the same lead scores lower');
});

test('when the CRM is down the visitor gets 202 and #ops-alerts gets the full lead', async () => {
  mocks.faults.crm = 1;
  const run = await submit(lead('hot: mid-size'));

  assert.equal(run.error, null);
  assert.equal(run.response.status, 202);
  assert.equal(run.calls.filter((c) => c.node === 'Upsert CRM contact').length, 3);
  assert.equal(messages('#sales-hot').length, 0);
  const [alert] = messages('#ops-alerts');
  assert.match(alert.text, /CRM upsert failed for priya\.raman@northwindtraders\.com \(503/);
  const payload = alert.blocks[1].text.text.replace(/```/g, '');
  assert.equal(JSON.parse(payload).email, 'priya.raman@northwindtraders.com', 'ops can re-enter the lead');
});

test('a repeat submission updates the same contact and keeps first-touch source', async () => {
  await submit(lead('hot: mid-size'));
  const again = await submit(lead('hot (repeat)'));

  assert.equal(again.response.status, 201);
  const all = contacts();
  assert.equal(all.length, 1);
  assert.equal(all[0].submissions, 2);
  assert.equal(all[0].source, 'google');
  assert.equal(all[0].latestSource, 'linkedin');
  assert.equal(all[0].phone, '+12065550142', 'a blank field does not wipe the stored value');
  assert.match(messages('#sales-hot')[1].blocks.at(-1).elements[0].text, /returning lead \(2 submissions\)/);
  assert.ok(JSON.stringify(messages('#sales-hot')[1].blocks).includes('+12065550142'), 'phone from the CRM record');
});

test('if Slack is down the lead is still saved and the execution is marked failed', async () => {
  mocks.faults.slack = 1;
  const run = await submit(lead('hot: mid-size'));

  assert.equal(run.response.status, 201);
  assert.equal(contacts().length, 1);
  assert.equal(run.error?.node, 'Notify #sales-hot');
  assert.equal(run.calls.filter((c) => c.node === 'Notify #sales-hot').length, 3);
});

test('a bad credential surfaces as a failed CRM call, not a silent success', async () => {
  const run = await runWorkflow(workflow, {
    body: lead('hot: mid-size'),
    env: mocks.env,
    credentials: { ...credentials, CrmApiKey000001: { name: 'Authorization', value: 'Bearer wrong' } },
  });
  assert.equal(run.response.status, 202);
  assert.match(messages('#ops-alerts')[0].text, /401/);
});

function syncRecords(data) {
  if (!data) return null;
  return data;
}

function throttleRequests(data) {
  if (!data) return null;
  return data;
}

function cleanupResources(data) {
  if (!data) return null;
  return data;
}