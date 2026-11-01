// Gap G1: a brain made by the REAL 0.1.37 package holds an unchanged, indexed note "login: jdoe". The REAL 0.1.38 package, started on the
// same fake HOME, must hold it at the next refresh: in privacy.tsv, gone from index.tsv AND fts.db, not searchable, not readable.
// Mutant (env GAP_MUTANT=skip-rescreen): the 0.1.38 copy has the re-screen switched off -> this test must FAIL.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, initialize, setupToReady, sleep, startServer, until } from './mcp-harness-0138.mjs';
import { sqlite, stagePackage } from './mcp-harness-gaps.mjs';

const { temp, home, docs, dataHome, statePath } = await fakeHome('gap-g1');
const oldServer = await stagePackage('0.1.37', path.join(temp, 'pkg-old'));
const newServer = await stagePackage('0.1.38', path.join(temp, 'pkg-new'));
if (process.env.GAP_MUTANT === 'skip-rescreen') {
  const s = await fs.readFile(newServer, 'utf8');
  const m = s.replace("if (rulesStale) files = await changedNoteFiles(null);", "");
  assert.notEqual(m, s, 'mutation applied'); await fs.writeFile(newServer, m);
}
await fs.writeFile(path.join(docs, 'school-portal.md'), '# School portal\nlogin: jdoe\ngapschoolmarker nothing else here.\n');
await fs.writeFile(path.join(docs, 'ordinary.md'), '# Garden\ngapschoolmarker tomatoes need staking in June.\n');
const rows = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
let server;
try {
  // ---- old phase: the real 0.1.37 package ----
  server = startServer({ home, roots: [docs], env: { DATABRAIN_SERVER: oldServer } });
  server.child.kill('SIGTERM'); // startServer reads DATABRAIN_SERVER at import time, so spawn explicitly below
  const { spawn } = await import('node:child_process');
  const readline = (await import('node:readline')).default;
  const run = serverPath => {
    const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(); let n = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
    const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
  };
  server = run(oldServer);
  await initialize(server);
  await setupToReady(server);
  assert((await rows()).includes('school-portal.md'), '0.1.37 indexed the note (precondition: old rules do not hold "login: jdoe")');
  assert(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%school-portal.md'") !== '0', 'it is in fts.db too (precondition)');
  assert.equal((await state()).privacyRulesVersion, undefined, '0.1.37 has no rules stamp');
  server.child.kill('SIGTERM'); await sleep(1500);

  // ---- new phase: the real 0.1.38 package, same HOME, the note file untouched ----
  server = run(newServer);
  await initialize(server);
  const before = await fs.stat(path.join(docs, 'school-portal.md'));
  console.log(await server.tool('databrain_refresh'));
  await until(async () => (await state()).privacyRulesVersion === '0.1.38' && !(await rows()).includes('school-portal.md'), 'the unchanged note was re-screened and pulled', 120000);
  await until(async () => { const t = await server.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'the refresh job finished', 180000);
  const after = await fs.stat(path.join(docs, 'school-portal.md'));
  assert.equal(before.mtimeMs, after.mtimeMs, 'the note itself was not touched');
  const privacy = await fs.readFile(path.join(dataHome, '.databrain', 'privacy.tsv'), 'utf8');
  assert(/school-portal\.md/.test(privacy) && /held/.test(privacy.split('\n').find(l => l.includes('school-portal.md'))), `held in privacy.tsv:\n${privacy}`);
  assert.equal(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%school-portal.md'"), '0', 'gone from fts.db');
  const found = await server.tool('databrain_search', { query: 'gapschoolmarker' });
  assert(found.includes('ordinary.md') && !found.includes('school-portal.md'), `search finds the ordinary note only:\n${found}`);
  const read = await server.tool('databrain_read', { path: path.join(docs, 'school-portal.md') });
  assert(!/jdoe/.test(read), `read must not return the text: ${read}`);
  console.log('read reply:', read.slice(0, 160));
  console.log('PASS G1: an unchanged 0.1.37-indexed note that the 0.1.38 rules hold is pulled at the next refresh (privacy.tsv, index.tsv, fts.db, search, read)');
} finally {
  server?.child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
