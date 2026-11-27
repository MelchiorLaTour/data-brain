// Part 19 (0.2.1): the server uses the parked list. A file that sits on disk, is not indexed, and is listed in left-out.json twice with its current size and
// modification time makes NO refresh start (it is not "new"); the same file, not listed, does start one and is indexed. Fake HOME, invented files.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

async function scenario(parkIt) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-leftwire-')));
  const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const realDocs = await fs.realpath(docs);
  await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nleftwireplainmarker an ordinary note.\n');
  const dataHome = path.join(home, 'DataBrain');
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'ignore'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    if (chatgpt) { await call('databrain_setup_start', { folders: [realDocs] }); await call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
    else await call('databrain_setup_start');
    await until(async () => {
      const status = await call('databrain_setup_status');
      if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await call('databrain_privacy', { action: 'decide', keep: [] });
      return /Stage: (?:verification pending|ready)\./.test(status);
    }, 'setup reaches ready');
    await sleep(2500);
    const late = path.join(realDocs, 'late.md');
    await fs.writeFile(late, '# Late\nleftwirelatemarker added after setup.\n');
    if (parkIt) {
      const info = await fs.stat(late);
      await fs.writeFile(path.join(dataHome, '.databrain', 'left-out.json'), JSON.stringify({ [late]: { fp: `${info.size}:${Math.round(info.mtimeMs)}`, count: 2 } }));
    }
    for (let i = 0; i < 3; i++) { await sleep(1500); await call('databrain_search', { query: 'leftwireplainmarker' }); }
    await sleep(3000);
    const log = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '');
    const refreshes = log.split('\n').filter(line => /\trefresh\t[0-9a-f]+\tjob-start\t/.test(line)).length;
    const indexed = (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).includes('/late.md\t');
    return { refreshes, indexed };
  } finally { child.kill('SIGKILL'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }); }
}
// The recording side has no natural fixture any more (the one real cause of a permanent skip, a long frontmatter, is fixed at its root), so it is checked in the
// source: the pass that reads ingest-skipped.tsv must hand the files to recordLeftOut.
const serverSource = await fs.readFile(serverScript, 'utf8');
const collect = serverSource.slice(serverSource.indexOf('async function collectIngestSkipped'), serverSource.indexOf('async function performAutoRefresh'));
assert(/recordLeftOut\(path\.join\(stateDir, 'left-out\.json'\)/.test(collect), 'collectIngestSkipped records the left-out files for parking');
const control = await scenario(false);
assert(control.refreshes >= 1 && control.indexed, `control: a new file that is not parked starts a refresh and is indexed (${JSON.stringify(control)})`);
const parked = await scenario(true);
assert.equal(parked.refreshes, 0, `a parked file starts no refresh (${JSON.stringify(parked)})`);
assert.equal(parked.indexed, false, 'and it is left alone, not indexed');
console.log(`PASS: a parked file does not count as new (no refresh, not indexed); the same file unparked starts one refresh and is indexed (${chatgpt ? 'ChatGPT' : 'Claude'} host)`);
