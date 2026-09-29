// Synthetic MCP-level held-out workflow probe. Query variants and answer keys
// are separate from source text. This validates tool plumbing only; it cannot
// test whether Claude invents good variants or correctly explains evidence.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import readline from 'node:readline';

const [engine] = process.argv.slice(2);
assert(engine, 'usage: test_mcp_multivariant_workflow.mjs PACKAGED_ENGINE_DIRECTORY');
const launcher = process.env.DATABRAIN_TEST_LAUNCHER;
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-multivariant-')));
const home = path.join(temp, 'home');
const desktop = path.join(home, 'Desktop');
const dataHome = path.join(desktop, 'DataBrain');
const corpus = path.join(temp, 'approved-sources');
const selectionFile = path.join(temp, 'selection.txt');
await fs.mkdir(desktop, { recursive: true });
await fs.mkdir(corpus);

// The answer key is held in this test file; fixture note names and prose do not
// contain the queried synthetic code words.
const target = path.join(corpus, 'overnight-response.md');
const decoy = path.join(corpus, 'incident-process.md');
await fs.writeFile(target, [
  '# Overnight service response',
  '',
  'During a nighttime platform failure, contact the on-call engineer first.',
  'The on-call engineer coordinates restoration and gives the incident lead an update.',
  '',
].join('\n'));
await fs.writeFile(decoy, [
  '# Incident process',
  '',
  'The service desk logs routine system questions during normal office hours.',
  'The change coordinator schedules planned maintenance after hours.',
  '',
].join('\n'));

const server = spawn(launcher || process.execPath,
  launcher ? [] : [path.join(engine, 'setup/mcp/server.mjs')], {
  env: {
    ...process.env,
    HOME: home,
    DATABRAIN_ENGINE_DIR: engine,
    DATABRAIN_TEST_HOME: dataHome,
    DATABRAIN_TEST_SELECTION_FILE: selectionFile,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const replies = new Map();
let stderr = '';
server.stderr.setEncoding('utf8');
server.stderr.on('data', chunk => { stderr += chunk; });
readline.createInterface({ input: server.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id !== undefined) replies.get(message.id)?.(message);
});
let requestId = 0;
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      replies.delete(id);
      reject(new Error(`Timed out waiting for ${method}; server stderr: ${stderr}`));
    }, 30000);
    replies.set(id, message => {
      clearTimeout(timer);
      replies.delete(id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function call(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  const text = result?.content?.find(block => block.type === 'text')?.text ?? '';
  assert(!result?.isError, `${name} failed: ${text}`);
  assert(!text.startsWith('DataBrain: '), `${name} failed: ${text}`);
  return text;
}
async function waitForStatus(predicate, description) {
  let last = '';
  for (let i = 0; i < 600; i += 1) {
    last = await call('databrain_setup_status');
    if (predicate(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}; last status: ${last}`);
}
function hitPaths(routeText) {
  return [...routeText.matchAll(/^\s*\d+\s+-?\d+(?:\.\d+)?\s+(.+)$/gm)].map(match => match[1].trim());
}

try {
  await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'synthetic-multivariant-workflow', version: '1' },
  });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  if (launcher) {
    await fs.writeFile(selectionFile, JSON.stringify({
      selections: { sources: [await fs.realpath(corpus)], 'destination-parent': [desktop] },
      approved: true,
    }));
    await call('databrain_setup_start');
    await waitForStatus(status => status.includes('Stage: taxonomy pending.') &&
      status.includes('Indexed rows: 2.') && /initial setup permissions: complete/.test(status), 'two-file index');
  } else {
    await fs.writeFile(selectionFile, `${desktop}\n`);
    await call('databrain_setup_start');
    await waitForStatus(status => status.includes('Stage: destination ready.'), 'isolated destination setup');
    await fs.writeFile(selectionFile, `${await fs.realpath(corpus)}\n`);
    await call('databrain_select_sources');
    await waitForStatus(status => status.includes('Stage: sources selected.'), 'synthetic source approval');
    await call('databrain_setup_run');
    await waitForStatus(status => status.includes('Stage: taxonomy pending.') && /initial indexing: complete/.test(status), 'two-file index');
  }

  // Variant one is deliberately unrelated lexical wording. Variant two is a
  // query reformulation with shared concepts; the oracle requires that it
  // recover the answer-bearing note and the MCP directs us to read that note.
  const knownRoute = await call('databrain_abstain_check', {
    queries: ['who handles an overnight platform failure?', 'nighttime outage on-call engineer response'],
  });
  assert.match(knownRoute, /Reading route only; not an answer or absence verdict/);
  assert.match(knownRoute, /overnight-response\.md/, knownRoute);
  const knownPaths = hitPaths(knownRoute);
  const knownHit = knownPaths.find(hit => path.basename(hit) === path.basename(target));
  assert(knownHit, `multi-variant route omitted the answer-bearing source: ${knownRoute}`);
  assert.match(knownRoute, /Read relevant evidence with databrain_read before answering or abstaining/);

  const excerpt = await call('databrain_read', { path: knownHit });
  assert.match(excerpt, /contact the on-call engineer first/i, excerpt);
  assert.match(excerpt, /Evidence from: .*overnight-response\.md/);

  // A no-candidate case must remain an advisory dry route and explicitly tell
  // the caller not to answer from this corpus.
  const absentRoute = await call('databrain_abstain_check', {
    queries: ['quartz lemur telescope', 'violet turnip meteorology'],
  });
  assert.match(absentRoute, /DRY — none of these query variants returned approved-source candidates/);
  assert.match(absentRoute, /Do not answer from DataBrain/);
  assert.match(absentRoute, /not an answer or absence verdict/);

  // A plausible but non-answering result must lead to reading, not an automatic
  // absence verdict. The test oracle knows the decoy does not answer the ask.
  const trapRoute = await call('databrain_abstain_check', {
    queries: ['who responds to a system incident?', 'routine system question after hours'],
  });
  const trapPaths = hitPaths(trapRoute);
  const decoyHit = trapPaths.find(hit => path.basename(hit) === path.basename(decoy));
  assert(decoyHit, `plausible non-answering candidate was not surfaced: ${trapRoute}`);
  assert(!/DRY —/.test(trapRoute), `a returned candidate was mislabeled as dry: ${trapRoute}`);
  const trapExcerpt = await call('databrain_read', { path: decoyHit });
  assert.match(trapExcerpt, /Evidence from:/);
  assert.match(trapExcerpt, /routine system questions/i);
  assert.doesNotMatch(trapExcerpt, /on-call engineer first/i, 'the plausible candidate is intentionally not answer-bearing');
  assert.match(trapRoute, /Read relevant evidence with databrain_read/);
  process.stdout.write([
    'PASS: real packaged MCP multi-variant call surfaced the synthetic answer-bearing source and databrain_read returned its excerpt.',
    'PASS: all-absent variants produced an explicit DRY route; a plausible candidate remained a read-first route.',
    'Scope: fixture/oracle validates tool plumbing and abstention guidance only; Claude-generated paraphrases, answer correctness, citations, and real Desktop behavior remain untested.',
  ].join('\n') + '\n');
} finally {
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await fs.rm(temp, { recursive: true, force: true });
}
