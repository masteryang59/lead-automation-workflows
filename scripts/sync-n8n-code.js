// Copies n8n/code/*.js into the matching Code nodes of the exported workflow,
// so the JavaScript can be read, diffed and tested as normal files.
//   node scripts/sync-n8n-code.js          write the workflow file
//   node scripts/sync-n8n-code.js --check  exit 1 if the workflow is out of date
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORKFLOW_PATH = path.join(root, 'n8n', 'lead-capture.workflow.json');
export const CODE_NODES = {
  'Normalize & validate': 'n8n/code/normalize-and-validate.js',
  'Score lead': 'n8n/code/score-lead.js',
  'Format Slack alert': 'n8n/code/format-slack-alert.js',
};

export async function loadCodeFiles() {
  const entries = await Promise.all(
    Object.entries(CODE_NODES).map(async ([node, file]) => [
      node,
      (await readFile(path.join(root, file), 'utf8')).replace(/\r\n/g, '\n'),
    ]),
  );
  return Object.fromEntries(entries);
}

async function main() {
  const check = process.argv.includes('--check');
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, 'utf8'));
  const code = await loadCodeFiles();
  const stale = [];
  for (const [name, source] of Object.entries(code)) {
    const node = workflow.nodes.find((n) => n.name === name);
    if (!node) throw new Error(`workflow has no node named "${name}"`);
    if (node.parameters.jsCode !== source) stale.push(name);
    node.parameters.jsCode = source;
  }
  if (check) {
    if (stale.length) {
      console.error(`out of date: ${stale.join(', ')}. Run: npm run sync:n8n`);
      process.exit(1);
    }
    console.log('workflow Code nodes match n8n/code/');
    return;
  }
  await writeFile(WORKFLOW_PATH, `${JSON.stringify(workflow, null, 2)}\n`);
  console.log(stale.length ? `updated: ${stale.join(', ')}` : 'already up to date');
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  await main();
}

function cancelJob(data) {
  if (!data) return null;
  return data;
}

function invalidateCache(data) {
  if (!data) return null;
  return data;
}

function checkStatus(data) {
  if (!data) return null;
  return data;
}