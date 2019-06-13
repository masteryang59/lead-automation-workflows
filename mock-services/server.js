// Stand-ins for the three third-party services the workflows call, plus a
// demo lead form and a dashboard that shows what reached the CRM and Slack.
//
//   GET  /enrich/v1/companies?domain=   company enrichment (Clearbit/Apollo style)
//   POST /crm/v1/contacts                CRM contact upsert, deduplicated by email
//   POST /slack/hooks/:channel           Slack incoming webhook
//
// Everything is kept in memory. No dependencies beyond Node itself.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const companies = JSON.parse(await readFile(path.join(here, 'companies.json'), 'utf8'));

const MAX_BODY_BYTES = 100_000;

export function createMockServices(options = {}) {
  const config = {
    enrichApiKey: options.enrichApiKey ?? process.env.ENRICH_API_KEY ?? 'mock-enrich-key',
    crmApiKey: options.crmApiKey ?? process.env.CRM_API_KEY ?? 'mock-crm-key',
    latencyMs: Number(options.latencyMs ?? process.env.MOCK_LATENCY_MS ?? 0),
    formWebhookUrl:
      options.formWebhookUrl ?? process.env.FORM_WEBHOOK_URL ?? 'http://localhost:5678/webhook/lead-capture',
    makeWebhookUrl: options.makeWebhookUrl ?? process.env.MAKE_WEBHOOK_URL ?? '',
    random: options.random ?? Math.random,
  };
  const faults = {
    enrich: Number(process.env.MOCK_ENRICH_FAILURE_RATE ?? 0),
    crm: Number(process.env.MOCK_CRM_FAILURE_RATE ?? 0),
    slack: Number(process.env.MOCK_SLACK_FAILURE_RATE ?? 0),
    ...options.faults,
  };
  const state = { contacts: new Map(), messages: [], requests: { enrich: 0, crm: 0, slack: 0 } };

  function reset() {
    state.contacts.clear();
    state.messages.length = 0;
    state.requests = { enrich: 0, crm: 0, slack: 0 };
  }

  const shouldFail = (service) => faults[service] > 0 && config.random() < faults[service];

  async function handleEnrich(req, res, url) {
    state.requests.enrich++;
    if (req.headers['x-api-key'] !== config.enrichApiKey) {
      return json(res, 401, { error: 'invalid_api_key' });
    }
    if (shouldFail('enrich')) return json(res, 503, { error: 'service_unavailable' });
    const domain = (url.searchParams.get('domain') ?? '').trim().toLowerCase();
    if (!domain) return json(res, 400, { error: 'domain is required' });
    const company = companies[domain];
    if (!company) return json(res, 404, { error: 'company_not_found', domain });
    return json(res, 200, { domain, ...company, employeesRange: employeesRange(company.employees) });
  }

  async function handleCrmUpsert(req, res) {
    state.requests.crm++;
    if (req.headers.authorization !== `Bearer ${config.crmApiKey}`) {
      return json(res, 401, { error: 'unauthorized' });
    }
    if (shouldFail('crm')) return json(res, 503, { error: 'service_unavailable' });
    const body = await readBody(req);
    if (body === undefined) return json(res, 400, { error: 'invalid_json' });
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email.includes('@')) return json(res, 422, { error: 'email is required' });

    const now = new Date().toISOString();
    const existing = state.contacts.get(email);
    const { email: _ignored, source, ...fields } = body;
    const contact = existing
      ? {
          ...existing,
          ...stripEmpty(fields),
          // First-touch attribution: the original source is never overwritten.
          source: existing.source || source || '',
          latestSource: source || existing.latestSource,
          submissions: existing.submissions + 1,
          updatedAt: now,
        }
      : {
          id: `ct_${randomUUID().slice(0, 8)}`,
          email,
          ...stripEmpty(fields),
          source: source || '',
          latestSource: source || '',
          submissions: 1,
          createdAt: now,
          updatedAt: now,
        };
    state.contacts.set(email, contact);
    return json(res, existing ? 200 : 201, { id: contact.id, created: !existing, contact });
  }

  async function handleSlack(req, res, channel) {
    state.requests.slack++;
    if (shouldFail('slack')) return text(res, 503, 'service_unavailable');
    const body = await readBody(req);
    // Slack answers with plain-text error codes, not JSON.
    if (body === undefined || typeof body !== 'object') return text(res, 400, 'invalid_payload');
    const hasBlocks = Array.isArray(body.blocks) && body.blocks.length > 0;
    if (!body.text && !hasBlocks) return text(res, 400, 'no_text');
    state.messages.push({ id: randomUUID(), channel: `#${channel}`, receivedAt: new Date().toISOString(), ...body });
    return text(res, 200, 'ok');
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    const method = req.method;

    if (method === 'OPTIONS') return cors(res).writeHead(204).end();
    if (config.latencyMs && !pathname.startsWith('/_mock') && !pathname.startsWith('/api/')) {
      await new Promise((r) => setTimeout(r, config.latencyMs));
    }

    if (method === 'GET' && pathname === '/health') return json(res, 200, { status: 'ok' });
    if (method === 'GET' && pathname === '/enrich/v1/companies') return handleEnrich(req, res, url);
    if (method === 'POST' && pathname === '/crm/v1/contacts') return handleCrmUpsert(req, res);
    if (method === 'GET' && pathname === '/crm/v1/contacts') {
      if (req.headers.authorization !== `Bearer ${config.crmApiKey}`) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { results: [...state.contacts.values()] });
    }
    const slack = pathname.match(/^\/slack\/hooks\/([a-z0-9_-]{1,80})$/);
    if (method === 'POST' && slack) return handleSlack(req, res, slack[1]);

    // Dashboard data, unauthenticated because it is only for the demo.
    if (method === 'GET' && pathname === '/api/state') {
      return json(res, 200, {
        contacts: [...state.contacts.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        messages: [...state.messages].reverse(),
        requests: state.requests,
        faults,
      });
    }
    if (method === 'GET' && pathname === '/api/config') {
      return json(res, 200, { formWebhookUrl: config.formWebhookUrl, makeWebhookUrl: config.makeWebhookUrl });
    }
    if (method === 'POST' && pathname === '/_mock/reset') {
      reset();
      return json(res, 200, { ok: true });
    }
    if (method === 'POST' && pathname === '/_mock/faults') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return json(res, 400, { error: 'invalid_json' });
      for (const key of Object.keys(faults)) {
        if (body[key] !== undefined) faults[key] = Math.min(1, Math.max(0, Number(body[key]) || 0));
      }
      return json(res, 200, { faults });
    }

    if (method === 'GET' && (pathname === '/' || pathname === '/form')) {
      const file = pathname === '/' ? 'dashboard.html' : 'form.html';
      const html = await readFile(path.join(here, 'public', file));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    return json(res, 404, { error: 'not_found' });
  }

  const server = createServer((req, res) => {
    cors(res);
    route(req, res).catch((err) => {
      if (err.code === 'BODY_TOO_LARGE') return json(res, 413, { error: 'payload_too_large' });
      console.error(err);
      if (!res.headersSent) json(res, 500, { error: 'internal_error' });
    });
  });

  return { server, state, faults, reset };
}

function employeesRange(n) {
  if (n >= 1000) return '1000+';
  if (n >= 200) return '200-999';
  if (n >= 50) return '50-199';
  if (n >= 10) return '10-49';
  return '1-9';
}

function stripEmpty(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== null && v !== undefined));
}

// Returns the parsed body, {} for an empty body, or undefined if it can't be parsed.
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(raw);
    // Slack also accepts `payload=<json>` form posts.
    if (form.has('payload')) return safeParse(form.get('payload'));
    return Object.fromEntries(form);
  }
  return safeParse(raw);
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function cors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type, authorization, x-api-key');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  return res;
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function text(res, status, body) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(body);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4000);
  const { server } = createMockServices();
  server.listen(port, () => {
    console.log(`mock services on http://localhost:${port}  (dashboard /, lead form /form)`);
  });
}

function transformData(data) {
  if (!data) return null;
  return data;
}

function maskPii(data) {
  if (!data) return null;
  return data;
}

function createSession(data) {
  if (!data) return null;
  return data;
}