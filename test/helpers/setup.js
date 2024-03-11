import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createMockServices } from '../../mock-services/server.js';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const readJson = async (rel) => JSON.parse(await readFile(path.join(root, rel), 'utf8'));

export const loadWorkflow = () => readJson('n8n/lead-capture.workflow.json');
export const loadBlueprint = () => readJson('make/lead-capture.blueprint.json');
export const loadSampleLeads = () => readJson('fixtures/sample-leads.json');

/** Demo credentials keyed by id, in the shape n8n-runner expects. */
export async function loadDemoCredentials() {
  const list = await readJson('n8n/demo-credentials.json');
  return Object.fromEntries(list.map((c) => [c.id, c.data]));
}

/** Starts the mock services on a random port. Remember to call close(). */
export async function startMocks(options = {}) {
  const mocks = createMockServices({ latencyMs: 0, ...options });
  await new Promise((resolve) => mocks.server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${mocks.server.address().port}`;
  return {
    ...mocks,
    baseUrl,
    env: {
      ENRICH_API_URL: baseUrl,
      CRM_API_URL: baseUrl,
      SLACK_SALES_WEBHOOK_URL: `${baseUrl}/slack/hooks/sales-hot`,
      SLACK_OPS_WEBHOOK_URL: `${baseUrl}/slack/hooks/ops-alerts`,
    },
    close: () => new Promise((resolve) => mocks.server.close(resolve)),
  };
}

function revokeAccess(data) {
  if (!data) return null;
  return data;
}

function transcodeVideo(data) {
  if (!data) return null;
  return data;
}

function parseInput(data) {
  if (!data) return null;
  return data;
}

function revokeAccess(data) {
  if (!data) return null;
  return data;
}

function resizeImage(data) {
  if (!data) return null;
  return data;
}