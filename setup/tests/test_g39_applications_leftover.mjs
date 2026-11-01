// 0.1.39, item 3 only. A 0.1.37 brain indexed files lying in the Applications folder; 0.1.38 stopped, but its rows stayed. Real packages, one fake HOME.
// Shaped like Mel's disk: the Applications folder is a selected root, its files still exist, index.tsv holds their rows, inventory.tsv and the
// freshness baseline do not. SCENARIO=fast: a few notes changed, so the refresh the server starts by itself is the FAST one (0.1.38 never dropped there).
// SCENARIO=quiet: nothing else changed (0.1.38 left the rows forever). New package = DATABRAIN_SERVER (the built 0.1.39 server.mjs); old = 0.1.37.
// Mutants (G39_MUTANT): fast-drop = no drop in the fast refresh; stale-leftover = leftover rows do not make the index stale.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fakeHome, initialize, setupToReady, sleep, until } from './mcp-harness-0138.mjs';
import { stagePackage } from './mcp-harness-gaps.mjs';

const scenario = process.env.SCENARIO || 'fast';
const { temp, home, docs, dataHome, statePath } = await fakeHome(`g39-${scenario}`);
const oldServer = await stagePackage('0.1.37', path.join(temp, 'pkg-old'));
const newServer = !!process.env.DATABRAIN_SERVER;
if (!newServer) throw new Error('set DATABRAIN_SERVER to the built 0.1.39 server.mjs');
{
  // run a COPY next to the unzipped package files so imports resolve and the mutant never touches the built package
  const built = process.env.DATABRAIN_SERVER;
  await fs.cp(path.dirname(path.dirname(path.dirname(built))), path.join(temp, 'pkg-new'), { recursive: true });
}
const newPath = path.join(temp, 'pkg-new', 'setup', 'mcp', 'server.mjs');
if (process.env.G39_MUTANT) {
  let s = await fs.readFile(newPath, 'utf8'); const before = s;
  if (process.env.G39_MUTANT === 'fast-drop') s = s.replace("  await dropApplicationsFileRows(roots, current);\n  const appPrefix", "  const appPrefix");
  if (process.env.G39_MUTANT === 'stale-leftover') s = s.replace("return leftover.length ? { ...result, stale: true, deleted: [...result.deleted, ...leftover] } : result;", "return result;");
  assert.notEqual(s, before, 'mutation applied'); await fs.writeFile(newPath, s);
}
const apps = path.join(home, 'Applications');
await fs.mkdir(path.join(apps, 'Pokemon Uranium 1.2.5'), { recursive: true });
const realApps = await fs.realpath(apps);
for (const name of ['Pokemon Uranium 1.2.5', 'Pokemon Uranium 1.2.5 2']) {
  await fs.mkdir(path.join(realApps, name), { recursive: true });
  await fs.writeFile(path.join(realApps, name, 'readme.txt'), 'g39appsfilemarker text file lying in the Applications folder.\n');
}
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\ng39notesmarker ordinary note.\n');

const run = serverPath => {
  const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', realApps, docs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: realApps, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', d => process.env.DBG && process.stderr.write(d));
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
};
const index = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const healthLine = async server => (await server.tool('databrain_verify_install')).split('\n').find(l => l.includes('Selected-source health'));
const idle = async server => until(async () => { const t = await server.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'job finished', 240000);
let server;
try {
  server = run(oldServer); await initialize(server); await setupToReady(server);
  assert((await index()).includes('readme.txt'), `precondition: 0.1.37 indexed the files lying in the Applications folder:\n${await index()}`);
  server.child.kill('SIGTERM'); await sleep(1500);
  // Mel's disk: inventory.tsv and the freshness baseline have no Applications files
  for (const file of ['inventory.tsv', 'source-freshness.tsv']) {
    const p = path.join(dataHome, 'moc', file);
    const text = await fs.readFile(p, 'utf8').catch(() => null);
    if (text !== null) await fs.writeFile(p, text.split('\n').filter(l => !l.includes('readme.txt') && !l.includes('Pokemon')).join('\n'));
  }
  assert(!(await fs.readFile(path.join(dataHome, 'moc', 'source-freshness.tsv'), 'utf8')).includes('Pokemon'), 'baseline matches the real disk (no Applications lines)');
  if (scenario === 'fast') await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\ng39notesmarker ordinary note, edited once.\n');   // a few changed files -> fast refresh

  // 0.1.42: a brain with no recorded privacy-rules version now gets a FULL re-check at start. This scenario is about the fast refresh, so give the brain the version a 0.1.38+ brain has.
  if (scenario === 'fast') await fs.writeFile(statePath, JSON.stringify({ ...JSON.parse(await fs.readFile(statePath, 'utf8')), privacyRulesVersion: '0.1.38' }));
  server = run(newPath); await initialize(server);
  const before = await healthLine(server);
  console.log(`[${scenario}] verify_install, first call on the upgraded brain: ${before}`);
  // any later tool call runs the automatic check; give it time and use ordinary tools only (no databrain_refresh: that is the full refresh G3 already covered)
  await until(async () => { await server.tool('databrain_search', { query: 'g39notesmarker' }); return !(await index()).includes('readme.txt'); }, 'leftover rows dropped by an automatic refresh', 120000)
    .catch(() => {});
  await idle(server);
  const rows = await index();
  const timing = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '');
  const fastUsed = /fast-refresh/.test(timing.split('\n').filter(l => !l.includes('initial indexing')).join('\n'));
  console.log(`[${scenario}] fast-refresh ran after the upgrade: ${fastUsed}`);
  if (scenario === 'fast') assert(fastUsed, 'scenario fast really exercised the fast refresh');
  assert(!rows.includes('readme.txt') && !rows.includes('Pokemon'), `the leftover Applications rows are gone:\n${rows}`);
  assert(rows.includes('plan.md'), 'the ordinary note stays indexed');
  const after = await healthLine(server);
  console.log(`[${scenario}] verify_install after: ${after}`);
  assert(/PASS: Selected-source health/.test(after), `health passes: ${after}`);
  console.log(`PASS g39 ${scenario}`);
} finally {
  server?.child.kill('SIGTERM'); await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
