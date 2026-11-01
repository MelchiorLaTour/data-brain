// Installing a newer package over an older one (same brain folder, same folder list) keeps the index:
// no second "initial indexing", no extraction, ingest or search-index rebuild, and the index files are not rewritten.
// The "older package" is a copy of this package stamped with an older version, in its own folder.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const newServer = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const packageRoot = path.resolve(path.dirname(newServer), '../..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-update-keeps-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

// the older install: same files, older version string, in a different folder (as a real update replaces the extension folder)
const oldRoot = path.join(temp, 'old-package');
await fs.mkdir(path.join(oldRoot, 'setup/mcp'), { recursive: true });
await fs.cp(path.join(packageRoot, 'bin'), path.join(oldRoot, 'bin'), { recursive: true });
for (const file of await fs.readdir(path.dirname(newServer))) {
  if (/\.(mjs|js|json)$/.test(file)) await fs.copyFile(path.join(path.dirname(newServer), file), path.join(oldRoot, 'setup/mcp', file));
}
const oldServer = path.join(oldRoot, 'setup/mcp/server.mjs');
const source = await fs.readFile(oldServer, 'utf8');
const stamped = source.replace(/const SERVER_VERSION = '[^']+';/, "const SERVER_VERSION = '0.1.5';");
assert.notEqual(stamped, source, 'could not stamp an older version into the copy');
await fs.writeFile(oldServer, stamped);

async function session(home, roots, script, run) {
  const child = spawn(process.execPath, [script, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
}

async function snapshot(dir) {   // path -> "inode:size:mtimeMs" for every file under dir
  const out = new Map();
  async function walk(d) {
    for (const entry of await fs.readdir(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) await walk(p);
      else if (entry.isFile()) { const s = await fs.stat(p); out.set(p, `${s.ino}:${s.size}:${s.mtimeMs}`); }
    }
  }
  await walk(dir);
  return out;
}

try {
  const home = path.join(temp, 'home');
  const notes = path.join(home, 'Notes');
  await fs.mkdir(notes, { recursive: true });
  const root = await fs.realpath(notes);
  for (let i = 0; i < 8; i++) await fs.writeFile(path.join(root, `note${i}.md`), `# Note ${i}\nkeptmarker${i} stays searchable after the update.\n`);
  const dataHome = path.join(home, 'DataBrain');
  const timingLog = path.join(dataHome, '.databrain', 'stage-timing.log');
  const settled = async tool => /Stage: ready\./.test(await tool('databrain_setup_status'));

  // 1) the older package makes the brain and reaches ready by itself
  await session(home, [root], oldServer, async tool => {
    await tool('databrain_setup_start');
    await until(async () => {
      const status = await tool('databrain_setup_status');
      if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
      return /Stage: ready\./.test(status);
    }, 'older package reached ready');
    const hit = await tool('databrain_search', { query: 'keptmarker3' });
    assert(/note3\.md/.test(hit), `older package finds the note: ${hit.slice(0, 300)}`);
  });
  await sleep(1500);   // anything the older server's exit still writes is written before the snapshot
  const before = await snapshot(dataHome);
  const logBefore = (await fs.readFile(timingLog, 'utf8')).split('\n').filter(Boolean);
  assert(before.has(path.join(dataHome, 'moc', 'fts.db')), 'the older package built a search index');

  // 2) the newer package starts on the same brain and folder list
  await session(home, [root], newServer, async tool => {
    const status = await tool('databrain_setup_status');
    assert(/Stage: ready\./.test(status), `the update must find the brain ready, not start over: ${status.slice(0, 400)}`);
    assert(/Indexed rows: 8\./.test(status), `all 8 rows are still there: ${status.slice(0, 400)}`);
    await sleep(6000);   // time for the on-start checks (refresh, app check) to run if they were going to
    assert(await settled(tool), 'still ready after the on-start checks');
    const hit = await tool('databrain_search', { query: 'keptmarker5' });
    assert(/note5\.md/.test(hit), `the new package finds a note indexed by the older one: ${hit.slice(0, 300)}`);
  });

  // 3) nothing was rebuilt
  const logAfter = (await fs.readFile(timingLog, 'utf8')).split('\n').filter(Boolean);
  const added = logAfter.slice(logBefore.length);
  const rebuilt = added.filter(line => /\tinitial indexing\t|\tengine:(extract|build-index|ingest-root|rebuild|build-fts)\.sh\t|\ttaxonomy application\t/.test(line));
  assert.deepEqual(rebuilt, [], `the update must not re-index; new log lines:\n${added.join('\n')}`);
  const after = await snapshot(dataHome);
  const rewritten = [...before].filter(([file, stamp]) => /\/moc\/(fts\.db|index\.tsv|extracted\/|extract-report\.tsv)/.test(file) && after.get(file) !== stamp).map(([file]) => file);
  assert.deepEqual(rewritten, [], `index and extracts must not be rewritten by the update: ${rewritten.join(', ')}`);
  assert.equal([...after.keys()].filter(file => /\/moc\/extracted\//.test(file)).length, [...before.keys()].filter(file => /\/moc\/extracted\//.test(file)).length, 'no extract files were added or dropped');

  console.log('PASS: a newer package started on an older package\'s brain (same folder list) found it ready, kept every row, rebuilt nothing and rewrote no index file.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
