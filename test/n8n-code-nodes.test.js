// Unit tests for the JavaScript inside the workflow's Code nodes.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { runCodeNode } from './helpers/n8n-runner.js';
import { loadWorkflow } from './helpers/setup.js';

let workflow;
before(async () => {
  workflow = await loadWorkflow();
});

const normalize = (body) => runCodeNode(workflow, 'Normalize & validate', { items: [{ body }] })[0].json;

const baseLead = {
  email: 'dev@acme.io', firstName: 'Dev', lastName: 'Lead', fullName: 'Dev Lead', company: 'Acme',
  companyDomain: 'acme.io', isFreeEmail: false, phone: '', message: '', source: 'website',
  utm: { source: '', medium: '', campaign: '' }, submittedAt: '2026-10-29T12:00:00.000Z',
};
const score = (lead, enrichmentJson) => {
  const normalized = { lead: { ...baseLead, ...lead } };
  return runCodeNode(workflow, 'Score lead', {
    json: enrichmentJson ?? normalized,
    nodes: { 'Normalize & validate': normalized },
  }).json;
};
const company = (employees, industry = 'Retail') => ({
  domain: 'acme.io', name: 'Acme Inc', industry, employees, employeesRange: 'x', country: 'US', city: 'Austin',
});

test('normalize: trims, lowercases the email and splits the name', () => {
  const out = normalize({
    name: '  Mary   Ann  Smith ', email: ' Mary@Example.COM ', company: ' Example ', consent: 'on',
    phone: '(555) 010-9999', utm_source: 'Google', utm_campaign: 'fall',
  });
  assert.equal(out.status, 'ok');
  assert.deepEqual(out.errors, []);
  assert.equal(out.lead.email, 'mary@example.com');
  assert.equal(out.lead.firstName, 'Mary');
  assert.equal(out.lead.lastName, 'Ann Smith');
  assert.equal(out.lead.company, 'Example');
  assert.equal(out.lead.companyDomain, 'example.com');
  assert.equal(out.lead.phone, '5550109999');
  assert.equal(out.lead.source, 'google');
  assert.equal(out.lead.utm.campaign, 'fall');
  assert.equal(out.lead.consent, true);
});

test('normalize: accepts first_name/last_name and a JSON boolean consent', () => {
  const out = normalize({ first_name: 'Li', last_name: 'Wei', email: 'li@wei.cn', consent: true });
  assert.equal(out.status, 'ok');
  assert.equal(out.lead.fullName, 'Li Wei');
});

test('normalize: free email uses the website for the company domain', () => {
  const out = normalize({ name: 'A B', email: 'a@gmail.com', website: 'https://www.shop.example/about', consent: 'on' });
  assert.equal(out.lead.isFreeEmail, true);
  assert.equal(out.lead.companyDomain, 'shop.example');
  assert.equal(normalize({ name: 'A B', email: 'a@gmail.com', consent: 'on' }).lead.companyDomain, '');
  assert.equal(normalize({ name: 'A B', email: 'a@gmail.com', website: 'not a url at all', consent: 'on' }).lead.companyDomain, '');
});

test('normalize: parses website domains without URL (absent from the n8n sandbox)', () => {
  const domain = (website) => normalize({ name: 'A B', email: 'a@gmail.com', website, consent: 'on' }).lead.companyDomain;
  assert.equal(domain('www.fernwoodbakery.co'), 'fernwoodbakery.co');
  assert.equal(domain('HTTP://Shop.Example:8080/x?y#z'), 'shop.example');
  assert.equal(domain('https://user@shop.example'), 'shop.example');
  assert.equal(domain('localhost'), '');
  assert.equal(domain('javascript:alert(1)'), '');
});

test('normalize: lists every validation problem', () => {
  const out = normalize({ email: 'x@mailinator.com' });
  assert.equal(out.status, 'invalid');
  assert.deepEqual(out.errors, [
    'disposable email addresses are not accepted',
    'name is required',
    'consent to be contacted is required',
  ]);
  assert.equal(normalize({ name: 'A', email: 'a@b', consent: 'on' }).status, 'invalid');
  assert.equal(normalize({ name: 'A', email: 'a@b.com', consent: 'no' }).status, 'invalid');
});

test('normalize: the honeypot wins over everything else', () => {
  const out = normalize({ fax: 'x', email: 'not-an-email' });
  assert.equal(out.status, 'spam');
  assert.equal(out.lead, null);
});

test('normalize: caps long fields and drops non-string junk', () => {
  const out = normalize({ name: 'A B', email: 'a@b.com', consent: 'on', message: 'x'.repeat(5000), company: { $ne: 1 } });
  assert.equal(out.lead.message.length, 2000);
  assert.equal(out.lead.company, '');
});

test('normalize: a body sent without the webhook wrapper still works', () => {
  const [item] = runCodeNode(workflow, 'Normalize & validate', {
    items: [{ name: 'A B', email: 'a@b.com', consent: 'on' }],
  });
  assert.equal(item.json.status, 'ok');
});

test('score: firmographics, industry, intent, phone and source add up', () => {
  const out = score(
    { message: 'Can we book a DEMO?', phone: '+15550100', source: 'referral' },
    company(250, 'SaaS'),
  );
  assert.equal(out.score, 100);
  assert.equal(out.tier, 'hot');
  assert.equal(out.enrichmentStatus, 'matched');
  assert.deepEqual(out.reasons, [
    '+30 250 employees', '+20 target industry (SaaS)', '+10 work email', '+20 buying intent ("demo")',
    '+5 left a phone number', '+15 high-intent source (referral)',
  ]);
});

test('score: tier boundaries are 60 (hot) and 30 (warm)', () => {
  // 30 (size) + 20 (industry) + 10 (work email) = 60
  assert.equal(score({}, company(200, 'Fintech')).tier, 'hot');
  // 20 + 20 + 10 = 50
  assert.equal(score({}, company(199, 'Fintech')).tier, 'warm');
  // 10 + 0 + 10 + ... = 20
  assert.equal(score({}, company(10)).tier, 'cold');
  // 10 + 20 = 30
  assert.equal(score({ message: 'pricing?' }, company(9)).score, 30);
  assert.equal(score({ message: 'pricing?' }, company(9)).tier, 'warm');
});

test('score: intent words match whole words only', () => {
  assert.equal(score({ message: 'I love democracy and priceless art' }).reasons.length, 1);
});

test('score: enrichment status comes from what the previous node returned', () => {
  assert.equal(score({}, { error: { message: '404 - {"error":"company_not_found"}' } }).enrichmentStatus, 'not_found');
  assert.equal(score({}, { error: { message: '503 - service_unavailable' } }).enrichmentStatus, 'failed');
  assert.equal(score({ isFreeEmail: true, companyDomain: '' }).enrichmentStatus, 'skipped');
  assert.equal(score({ isFreeEmail: true, companyDomain: '' }).score, 0);
});

test('score: CRM body prefers the enriched company name', () => {
  assert.equal(score({}, company(50)).crmContact.company, 'Acme Inc');
  const plain = score({ company: 'Typed Co' }, { error: { message: '404' } }).crmContact;
  assert.equal(plain.company, 'Typed Co');
  assert.equal(plain.employees, null);
  assert.equal(plain.leadTier, 'cold');
});

test('slack: escapes user input and truncates long messages', () => {
  const scored = score({ fullName: 'Eve <script>', message: `<!channel> & ${'y'.repeat(400)}` }, company(500, 'SaaS'));
  const out = runCodeNode(workflow, 'Format Slack alert', {
    json: {},
    nodes: {
      'Score lead': scored,
      'Upsert CRM contact': { id: 'ct_1', created: true, contact: { submissions: 1 } },
    },
  }).json;
  const all = JSON.stringify(out.blocks);
  assert.ok(!all.includes('<!channel>'), 'no @channel ping from a form field');
  assert.ok(all.includes('&lt;!channel&gt; &amp;'));
  const quote = out.blocks.find((b) => b.type === 'section' && b.text?.text.startsWith('>'));
  assert.ok(quote.text.text.endsWith('y…'), 'cut at 280 characters before escaping');
  assert.equal(quote.text.text.match(/y/g).length, 280 - '<!channel> & '.length - 1);
  assert.ok(out.blocks[0].text.text.length <= 150, 'Slack header limit');
  assert.ok(!all.includes('returning lead'));
});

function importData(data) {
  if (!data) return null;
  return data;
}

function classifyIntent(data) {
  if (!data) return null;
  return data;
}

function initService(data) {
  if (!data) return null;
  return data;
}

function importData(data) {
  if (!data) return null;
  return data;
}

function detectLanguage(data) {
  if (!data) return null;
  return data;
}

function buildQuery(data) {
  if (!data) return null;
  return data;
}