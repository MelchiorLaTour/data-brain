// 0.1.38: Claude's default "Use built-in Node.js for MCP" refuses every child process that starts node or the app executable
// (process.execPath). The preload refuse-node-spawn-preload.mjs does the same here. Setup, saving a note, the relationship report,
// category review and a refresh must all work with it, and nothing may even try to start node. Before 0.1.38 the note save used
// spawnSync(process.execPath, ['-e', ...]) and failed in the real app while every suite (which runs under plain node) passed.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, here, initialize, setupToReady, sleep, startServer, until } from './mcp-harness-0138.mjs';

const { temp, home, docs, statePath } = await fakeHome('builtin-node');
const log = path.join(temp, 'refused.log');
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\nbuiltinnodemarker invented planning note.\n');
await fs.writeFile(path.join(docs, 'links.md'), '# Links\nSee [[plan]] for the builtinnodemarker plan.\n');
const server = startServer({ home, roots: [docs], env: { DATABRAIN_TEST_REFUSE_LOG: log }, nodeArgs: ['--import', path.join(here, 'refuse-node-spawn-preload.mjs')] });
const { child, tool } = server;
const note = (title, extra = {}) => ({ title, body: 'An invented note about sourdough.', keywords: ['sourdough', 'baking'], ...extra });
const refusedCalls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).trim();

try {
  await initialize(server);
  await setupToReady(server);
  assert.equal(await refusedCalls(), '', 'setup tried to start node');

  // saving notes (capture, filed note, synthesis) writes inside the server process
  const inbox = path.join(docs, 'inbox'); await fs.mkdir(inbox);
  for (const [toolName, args, title] of [['databrain_capture', note('Capture one'), 'Capture one'], ['databrain_file_note', note('Filed one', { themes: ['ideas'] }), 'Filed one'], ['databrain_save_synthesis', note('Synthesis one', { themes: ['ideas'] }), 'Synthesis one']]) {
    const reply = await tool(toolName, { ...args, folder: inbox });
    assert(!/cannot start|Node\.js subprocess|failed/i.test(reply), reply);
    await until(async () => (await tool('databrain_setup_status')).split('\n').some(line => line.includes('note write: complete') && line.includes(title)), `${title} saved`);
  }
  const saved = (await fs.readdir(inbox)).filter(name => name.endsWith('.md'));
  assert.equal(saved.length, 3, `three notes saved, found ${saved}`);
  assert(saved.every(name => /^\d{4}-\d{2}-\d{2} /.test(name)), 'dated file names');
  // never overwrites: the same title again gets a numbered name
  await tool('databrain_capture', { ...note('Capture one'), folder: inbox });
  await until(async () => (await fs.readdir(inbox)).filter(name => name.includes('Capture one')).length === 2, 'second Capture one saved under another name');
  assert.equal(await refusedCalls(), '', 'saving a note tried to start node');

  // relationship report, categories, search, refresh
  await tool('databrain_build_relationships');
  await until(async () => (await tool('databrain_setup_status')).split('\n').some(line => /relationship/i.test(line) && /complete/.test(line)), 'relationship report built');
  await tool('databrain_taxonomy_candidates');
  assert((await tool('databrain_search', { query: 'builtinnodemarker' })).includes('plan.md'), 'search works');
  await fs.writeFile(path.join(docs, 'later.md'), '# Later\nbuiltinnodelatermarker added after setup.\n');
  await tool('databrain_refresh');
  await until(async () => (await tool('databrain_search', { query: 'builtinnodelatermarker' })).includes('later.md'), 'refresh indexed the new file');
  assert.equal(await refusedCalls(), '', `something tried to start node: ${await refusedCalls()}`);

  // static guard: no engine script that the server runs starts node
  const serverSource = await fs.readFile(path.join(here, '../mcp/server.mjs'), 'utf8');
  const scripts = [...new Set([...serverSource.matchAll(/runEngine\('([\w.-]+\.sh)'/g)].map(match => match[1]))];
  assert(scripts.length > 5, 'found the engine scripts the server runs');
  for (const script of scripts) {
    const text = await fs.readFile(path.join(here, '../../bin', script), 'utf8');
    assert(!/^\s*(?:exec\s+)?node\s/m.test(text) && !/\|\s*node\s/.test(text), `${script} starts node; the built-in Node runtime cannot provide one`);
  }
  // the legacy relationship / category scripts are not run by the server either (the server builds both in-process)
  assert(!/runEngine\('(?:relationships|taxonomy)\.sh'/.test(serverSource), 'the server must not run relationships.sh or taxonomy.sh');
  console.log(`PASS: with child processes that start node refused (built-in Node), setup, three kinds of note save, relationship report, categories, search and refresh work; ${scripts.length} engine scripts start no node`);
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
