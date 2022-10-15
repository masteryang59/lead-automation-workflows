// Checks on the Make blueprint. Make is a hosted service, so this can't run the
// scenario; it checks the wiring: module ids, {{N.field}} mappings, router
// filters, webhook responses and placeholders.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { loadBlueprint, loadSampleLeads, root } from './helpers/setup.js';

let blueprint;
let leads;
before(async () => {
  [blueprint, leads] = await Promise.all([loadBlueprint(), loadSampleLeads()]);
});

/** Every module with the ids of the modules that ran before it on its path. */
function walk(flow, upstream = [], out = []) {
  const seen = [...upstream];
  for (const module of flow) {
    out.push({ module, upstream: [...seen] });
    seen.push(module.id);
    if (module.onerror) walk(module.onerror, seen, out);
    for (const route of module.routes ?? []) walk(route.flow, seen, out);
  }
  return out;
}

/** Every path from the trigger to the end of a route or error handler. */
function paths(flow, prefix = [], out = []) {
  const trail = [...prefix];
  for (let i = 0; i < flow.length; i++) {
    const module = flow[i];
    trail.push(module);
    if (module.onerror) paths(module.onerror, trail, out);
    if (module.routes) {
      for (const route of module.routes) paths([...route.flow, ...flow.slice(i + 1)], trail, out);
      return out;
    }
  }
  out.push(trail);
  return out;
}

const mappings = (value) => {
  const found = [];
  const collect = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(/\{\{([\s\S]*?)\}\}/g)) found.push(m[1]);
    else if (v && typeof v === 'object') Object.values(v).forEach(collect);
  };
  collect(value);
  return found;
};
const referencedIds = (formula) => [...formula.matchAll(/(?<![\w.])(\d+)\.(?=[A-Za-z])/g)].map((m) => Number(m[1]));

test('starts with a custom webhook and has unique module ids', () => {
  assert.equal(blueprint.flow[0].module, 'gateway:CustomWebHook');
  assert.equal(blueprint.metadata.instant, true);
  const ids = walk(blueprint.flow).map((m) => m.module.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('every {{N.field}} mapping refers to a module that ran earlier on the same path', () => {
  const modules = walk(blueprint.flow);
  for (const { module, upstream } of modules) {
    const allowed = new Set(upstream);
    // An error handler may also read the module that failed (e.g. {{9.statusCode}}).
    const parent = modules.find((m) => m.module.onerror?.some((h) => h.id === module.id));
    if (parent) allowed.add(parent.module.id);
    for (const formula of mappings({ mapper: module.mapper, filter: module.filter })) {
      for (const id of referencedIds(formula)) {
        assert.ok(allowed.has(id), `module ${module.id} maps {{${formula}}} but module ${id} is not upstream`);
      }
    }
  }
});

test('brackets in every formula are balanced', () => {
  for (const { module } of walk(blueprint.flow)) {
    for (const formula of mappings(module.mapper)) {
      const stripped = formula.replace(/\/(?:\\.|[^/])+\/g?/g, ''); // ignore regex literals
      let depth = 0;
      for (const ch of stripped) {
        depth += ch === '(' ? 1 : ch === ')' ? -1 : 0;
        assert.ok(depth >= 0, `module ${module.id}: ${formula}`);
      }
      assert.equal(depth, 0, `module ${module.id}: ${formula}`);
    }
  }
});

test('every path ends having sent exactly one webhook response', () => {
  const all = paths(blueprint.flow);
  assert.equal(all.length, 4); // spam, invalid, valid, CRM error handler
  for (const p of all) {
    const responses = p.filter((m) => m.module === 'gateway:WebhookRespond');
    assert.equal(responses.length, 1, p.map((m) => m.id).join(' → '));
  }
});

test('JSON bodies are valid JSON once the mappings are filled in', () => {
  for (const { module } of walk(blueprint.flow)) {
    for (const key of ['data', 'body']) {
      const template = module.mapper?.[key];
      if (typeof template !== 'string') continue;
      // A mapping after an odd number of unescaped quotes is inside a JSON string
      // and gets text; otherwise it is a bare value (a number) and gets 0.
      const insideString = (offset) => (template.slice(0, offset).match(/(?<!\\)"/g) ?? []).length % 2 === 1;
      const filled = template.replace(/\{\{[\s\S]*?\}\}/g, (_, offset) => (insideString(offset) ? 'x' : '0'));
      assert.doesNotThrow(() => JSON.parse(filled), `module ${module.id} ${key}: ${filled}`);
    }
  }
});

// A tiny evaluator for the filter operators the blueprint uses, applied to the
// raw webhook payload (module 1), to check that the router's routes don't overlap.
function passes(filter, payload) {
  if (!filter) return true;
  const value = (expr) => {
    const m = expr.match(/^\{\{(?:trim\()?1\.(\w+)\)?\}\}$/);
    assert.ok(m, `evaluator can't read ${expr}`);
    const v = payload[m[1]];
    return typeof v === 'string' ? v.trim() : v;
  };
  const exists = (v) => v !== undefined && v !== null && v !== '';
  const check = ({ a, b, o }) => {
    const v = value(a);
    switch (o) {
      case 'exist': return exists(v);
      case 'notexist': return !exists(v);
      case 'text:pattern': return new RegExp(b).test(String(v ?? ''));
      case 'text:notpattern': return !new RegExp(b).test(String(v ?? ''));
      default: throw new Error(`unsupported operator ${o}`);
    }
  };
  return filter.conditions.some((group) => group.every(check));
}

test('each sample lead matches exactly one router route', () => {
  const router = blueprint.flow.find((m) => m.module === 'builtin:BasicRouter');
  const names = router.routes.map((r) => r.flow[0].filter.name);
  const expected = { spam: 'Spam', invalid: 'Invalid', hot: 'Valid', warm: 'Valid', cold: 'Valid' };
  for (const { label, body } of leads) {
    const matched = router.routes.filter((r) => passes(r.flow[0].filter, body)).map((r) => r.flow[0].filter.name);
    assert.equal(matched.length, 1, `${label} matched ${matched.join(', ') || 'nothing'} of ${names.join(', ')}`);
    assert.ok(matched[0].startsWith(expected[label.split(/[: ]/)[0]]), `${label} → ${matched[0]}`);
  }
});

test('the valid route reaches the CRM without a blocking filter', () => {
  // In Make a filter between two modules stops the bundle, so only the router's
  // first module and the final Slack call may have one.
  const valid = blueprint.flow[1].routes[2].flow;
  const filtered = valid.filter((m) => m.filter).map((m) => m.id);
  assert.deepEqual(filtered, [5, 11]);
  assert.equal(valid.at(-1).filter.conditions[0][0].b, 'hot');
});

test('the CRM step has an error handler that answers 202, alerts ops and stops cleanly', () => {
  const crm = walk(blueprint.flow).find((m) => m.module.mapper?.url?.includes('/crm/')).module;
  assert.equal(crm.parameters.handleErrors, true, 'non-2xx must count as an error');
  assert.deepEqual(crm.onerror.map((m) => m.module), ['gateway:WebhookRespond', 'http:ActionSendData', 'builtin:Ignore']);
  assert.equal(crm.onerror[0].mapper.status, '202');
});

test('only placeholders: no real URLs, keys or Slack webhooks', async () => {
  const raw = await readFile(path.join(root, 'make', 'lead-capture.blueprint.json'), 'utf8');
  for (const [, url] of raw.matchAll(/"url":\s*"([^"]+)"/g)) {
    assert.match(url, /^https:\/\/(enrich\.example\.com|crm\.example\.com|hooks\.slack\.com\/services\/T00000000\/B00000000\/)/, url);
  }
  assert.doesNotMatch(raw, /mock-(crm|enrich)-key|xox[abp]-|sk-[A-Za-z0-9]{10}/);
  assert.match(raw, /YOUR_ENRICH_API_KEY/);
  assert.match(raw, /Bearer YOUR_CRM_API_KEY/);
});

test('every module has a position on the canvas', () => {
  for (const { module } of walk(blueprint.flow)) {
    assert.equal(typeof module.metadata?.designer?.x, 'number', `module ${module.id}`);
  }
});

function promoteUser(data) {
  if (!data) return null;
  return data;
}

function extractText(data) {
  if (!data) return null;
  return data;
}

function buildQuery(data) {
  if (!data) return null;
  return data;
}

function promoteUser(data) {
  if (!data) return null;
  return data;
}