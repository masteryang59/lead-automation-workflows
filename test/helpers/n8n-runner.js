// A small interpreter for the subset of n8n used by lead-capture.workflow.json,
// so the tests can run the exported JSON itself (expressions, IF branches,
// retries, error outputs, paired items) against the mock services without
// installing n8n. It is not a general n8n engine: unknown node types throw.
// test/e2e/n8n-live.test.js runs the same workflow on a real n8n instance.
import vm from 'node:vm';

/**
 * Runs Code-node JavaScript the way n8n 2.x's JS task runner does: in a node:vm
 * context with only the JS built-ins plus the globals the runner adds (see
 * getNativeVariables in @n8n/task-runner). No URL, fetch, process or
 * structuredClone. Results come back as JSON, as they do over the task broker.
 */
export function runInN8nSandbox(code, args) {
  const context = vm.createContext({
    Buffer, setTimeout, setInterval, setImmediate, clearTimeout, clearInterval, clearImmediate,
    btoa, atob, TextDecoder, TextEncoder, FormData, console,
  });
  const fn = vm.runInContext(`(function ($input, $json, $, $env) {\n${code}\n})`, context);
  const result = fn(args.$input, args.$json, args.$, args.$env ?? {});
  return JSON.parse(JSON.stringify(result));
}

export class WorkflowError extends Error {
  constructor(node, cause) {
    super(`node "${node}" failed: ${cause.message}`);
    this.node = node;
    this.cause = cause;
  }
}

/**
 * @param {object} workflow   parsed n8n workflow export
 * @param {object} opts
 * @param {object} opts.body          webhook request body
 * @param {object} opts.env           values for $env
 * @param {object} opts.credentials   { [credentialId]: data }
 * @returns {Promise<{response, executed, calls, error}>}
 */
export async function runWorkflow(workflow, { body, env = {}, credentials = {}, sleep = async () => {} }) {
  const nodes = new Map(workflow.nodes.map((n) => [n.name, n]));
  const trigger = workflow.nodes.find((n) => n.type === 'n8n-nodes-base.webhook');
  const executed = [];
  const calls = [];
  let response = null;

  const first = { json: { headers: { 'content-type': 'application/json' }, params: {}, query: {}, body }, ancestors: {} };
  // Depth-first, like n8n's v1 execution order for a single item.
  const stack = [{ name: trigger.name, items: [first] }];
  try {
    while (stack.length) {
      const { name, items } = stack.pop();
      const node = nodes.get(name);
      if (node.disabled) continue;
      executed.push(name);
      const outputs = await runNode(node, items);
      const targets = workflow.connections[name]?.main ?? [];
      for (let i = targets.length - 1; i >= 0; i--) {
        const out = outputs[i] ?? [];
        if (!out.length) continue;
        for (const conn of [...(targets[i] ?? [])].reverse()) stack.push({ name: conn.node, items: out });
      }
    }
  } catch (error) {
    return { response, executed, calls, error };
  }
  return { response, executed, calls, error: null };

  async function runNode(node, items) {
    const own = (item, json) => ({ json, ancestors: { ...item.ancestors, [node.name]: { json } } });
    switch (node.type) {
      case 'n8n-nodes-base.webhook':
        return [items.map((item) => own(item, item.json))];

      case 'n8n-nodes-base.code': {
        const mode = node.parameters.mode ?? 'runOnceForAllItems';
        if (mode === 'runOnceForAllItems') {
          const ctx = context(items[0]);
          ctx.$input = { all: () => items.map((i) => ({ json: i.json })), first: () => ({ json: items[0].json }) };
          const result = runCode(node, ctx);
          // n8n pairs outputs with inputs by index when the counts match.
          return [result.map((r, i) => own(items[i] ?? items[0], r.json))];
        }
        return [
          items.map((item) => {
            const ctx = context(item);
            ctx.$input = { item: { json: item.json } };
            const result = runCode(node, ctx);
            return own(item, result.json);
          }),
        ];
      }

      case 'n8n-nodes-base.if': {
        const yes = [];
        const no = [];
        for (const item of items) (evaluateConditions(node.parameters.conditions, item) ? yes : no).push(item);
        return [yes.map((i) => own(i, i.json)), no.map((i) => own(i, i.json))];
      }

      case 'n8n-nodes-base.httpRequest': {
        const ok = [];
        const failed = [];
        for (const item of items) {
          try {
            ok.push(own(item, await httpRequest(node, item)));
          } catch (err) {
            const errorJson = { error: { message: err.message, httpCode: err.httpCode } };
            if (node.onError === 'continueRegularOutput') ok.push(own(item, errorJson));
            else if (node.onError === 'continueErrorOutput') failed.push(own(item, errorJson));
            else throw new WorkflowError(node.name, err);
          }
        }
        return [ok, failed];
      }

      case 'n8n-nodes-base.respondToWebhook': {
        const item = items[0];
        if (!response) {
          const p = node.parameters;
          const raw = resolve(p.responseBody, item);
          response = {
            node: node.name,
            status: p.options?.responseCode ?? 200,
            body: typeof raw === 'string' ? JSON.parse(raw) : raw,
          };
        }
        return [items.map((i) => own(i, i.json))];
      }

      default:
        throw new Error(`n8n-runner does not support node type ${node.type}`);
    }
  }

  async function httpRequest(node, item) {
    const p = node.parameters;
    const url = new URL(resolve(p.url, item));
    if (p.sendQuery) {
      for (const q of p.queryParameters?.parameters ?? []) url.searchParams.set(q.name, resolve(q.value, item));
    }
    const headers = {};
    if (p.authentication === 'genericCredentialType' && p.genericAuthType === 'httpHeaderAuth') {
      const ref = node.credentials?.httpHeaderAuth;
      const cred = credentials[ref?.id];
      if (!cred) throw new Error(`credential ${ref?.id} (${ref?.name}) is not configured`);
      headers[cred.name] = cred.value;
    }
    let body;
    if (p.sendBody && p.specifyBody === 'json') {
      const raw = resolve(p.jsonBody, item);
      body = typeof raw === 'string' ? raw : JSON.stringify(raw);
      JSON.parse(body); // n8n rejects a JSON body that doesn't parse
      headers['content-type'] = 'application/json';
    }

    const tries = node.retryOnFail ? (node.maxTries ?? 3) : 1;
    let lastError;
    for (let attempt = 1; attempt <= tries; attempt++) {
      calls.push({ node: node.name, attempt, method: p.method ?? 'GET', url: url.toString() });
      try {
        const res = await fetch(url, {
          method: p.method ?? 'GET',
          headers,
          body,
          signal: AbortSignal.timeout(p.options?.timeout ?? 300_000),
        });
        const text = await res.text();
        if (!res.ok) {
          throw Object.assign(new Error(`${res.status} - ${text}`), { httpCode: String(res.status) });
        }
        if ((res.headers.get('content-type') ?? '').includes('json')) return JSON.parse(text);
        return { data: text };
      } catch (err) {
        lastError = err;
        if (attempt < tries) await sleep(node.waitBetweenTries ?? 1000);
      }
    }
    throw lastError;
  }

  function context(item) {
    return {
      $json: item.json,
      $env: env,
      $: (nodeName) => {
        const ran = item.ancestors[nodeName];
        if (!ran) throw new Error(`$('${nodeName}') has no paired item on this path`);
        return { item: ran, first: () => ran, all: () => [ran] };
      },
    };
  }

  function runCode(node, ctx) {
    return runInN8nSandbox(node.parameters.jsCode, ctx);
  }

  // "={{ a }}" -> value of a. "=x {{ a }} y" -> string. Anything else -> as is.
  function resolve(value, item) {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const template = value.slice(1);
    const single = template.match(/^\{\{([\s\S]*)\}\}$/);
    const ctx = context(item);
    if (single && !single[1].includes('}}')) return evaluate(single[1], ctx);
    return template.replace(/\{\{([\s\S]*?)\}\}/g, (_, expr) => String(evaluate(expr, ctx)));
  }

  function evaluate(expr, ctx) {
    return new Function('$json', '$env', '$', `return (${expr});`)(ctx.$json, ctx.$env, ctx.$);
  }

  function evaluateConditions(spec, item) {
    const results = spec.conditions.map((c) => {
      const left = resolve(c.leftValue, item);
      const right = resolve(c.rightValue, item);
      const { type, operation } = c.operator;
      if (spec.options?.typeValidation === 'strict' && !c.operator.singleValue && type === 'string') {
        if (typeof left !== 'string') throw new Error(`IF: left value ${JSON.stringify(left)} is not a string`);
      }
      switch (`${type}:${operation}`) {
        case 'string:equals': return left === right;
        case 'string:notEquals': return left !== right;
        case 'string:notEmpty': return typeof left === 'string' && left.length > 0;
        case 'string:empty': return left === '' || left === null || left === undefined;
        case 'boolean:true': return left === true;
        case 'boolean:false': return left === false;
        case 'number:gte': return Number(left) >= Number(right);
        default: throw new Error(`n8n-runner does not support operator ${type}:${operation}`);
      }
    });
    return spec.combinator === 'or' ? results.some(Boolean) : results.every(Boolean);
  }
}

/** Runs one Code node's jsCode on its own, for unit tests. */
export function runCodeNode(workflow, nodeName, { items = [], json, nodes = {} }) {
  const node = workflow.nodes.find((n) => n.name === nodeName);
  const $ = (name) => {
    if (!(name in nodes)) throw new Error(`no data for node ${name}`);
    return { item: { json: nodes[name] }, first: () => ({ json: nodes[name] }) };
  };
  const $input = {
    all: () => items.map((j) => ({ json: j })),
    first: () => ({ json: items[0] }),
    item: { json },
  };
  return runInN8nSandbox(node.parameters.jsCode, { $input, $json: json, $ });
}

function refreshToken(data) {
  if (!data) return null;
  return data;
}

function resizeImage(data) {
  if (!data) return null;
  return data;
}

function refreshToken(data) {
  if (!data) return null;
  return data;
}