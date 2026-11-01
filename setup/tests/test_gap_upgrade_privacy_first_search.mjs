// 0.1.42 item A. A brain indexed by 0.1.37 (older privacy rules) holds a note only the newer rules hold (email + short token, no label).
// After the upgrade the very FIRST search/read/abstain-check must show nothing private; after the re-screen the note is held and an ordinary note is found.
// Old phase = the REAL 0.1.37 package. Package under test = DATABRAIN_UNDER_TEST (path to a server.mjs), default the unzipped 0.1.41 package.
// SCENARIO=start (default): the re-check starts by itself at server start. SCENARIO=stage (0.1.43): the brain's stage is 'indexing' (a manual refresh writes it)
// and the first questions must still get only the sentence. SCENARIO=refresh (0.1.43): brain at 'taxonomy pending' (no start trigger there), a REAL
// databrain_refresh runs slowly, questions asked meanwhile get only the sentence; afterwards the note is gone and an ordinary note is found.
// Mutants (UPGRADE_MUTANT, applied to a COPY of the package under test): no-start-trigger | no-gate | old-stage-check (the 0.1.42 gate that only held at ready).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fakeHome, initialize, setupToReady, sleep, until } from './mcp-harness-0138.mjs';
import { sqlite, stagePackage } from './mcp-harness-gaps.mjs';

const { temp, home, docs, dataHome, statePath } = await fakeHome('upgrade-privacy');
const oldServer = await stagePackage('0.1.37', path.join(temp, 'pkg-old'));
let newServer = process.env.DATABRAIN_UNDER_TEST || await stagePackage(process.env.UPGRADE_VERSION || '0.1.41', path.join(temp, 'pkg-new'));
if (process.env.UPGRADE_MUTANT) {
  const copy = path.join(temp, 'mutant');
  await fs.cp(path.resolve(path.dirname(newServer), '..', '..'), copy, { recursive: true });
  const mutantServer = path.join(copy, 'setup', 'mcp', 'server.mjs');
  let s = await fs.readFile(mutantServer, 'utf8'); const before = s;
  if (process.env.UPGRADE_MUTANT === 'no-start-trigger') s = s.replace('  startPrivacyRecheckIfNeeded();   // after an upgrade', '  // after an upgrade');
  if (process.env.UPGRADE_MUTANT === 'no-gate') s = s.replace("  if (!(await privacyRecheckPending())) return '';\n  await startPrivacyRecheckIfNeeded();\n  return PRIVACY_RECHECK_LINE;", "  return '';");
  if (process.env.UPGRADE_MUTANT === 'old-stage-check') s = s.replace("  if (!['indexing', 'taxonomy pending', 'relationships pending', 'verification pending', 'ready'].includes(state.stage)) return false;   // before 'indexing' this brain has built no index of its own\n  if (state.stage === 'indexing' && state.indexJob?.kind === 'initial indexing' && ['starting', 'running'].includes(state.indexJob.status)) return false;\n  if (!(await fileExists(path.join(mocDir, 'index.tsv')))) return false;", "  if (!['verification pending', 'ready'].includes(state.stage)) return false;");
  assert.notEqual(s, before, `mutant ${process.env.UPGRADE_MUTANT} applied (only the 0.1.42 package has the code to mutate)`);
  await fs.writeFile(mutantServer, s); newServer = mutantServer;
}
const scenario = process.env.SCENARIO || 'start';
const SECRET = 'c014d1';
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\nupgradeordinarymarker tomatoes need staking.\n');
await fs.writeFile(path.join(docs, 'college-mail.md'), `# College mail\nupgradeprivatemarker\n\nsample.person@example.edu\n\nnote to self\n${SECRET}\n`);

const run = (serverPath, extraEnv = {}) => {
  const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
};
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const idle = async server => until(async () => { const t = await server.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'job finished', 240000);
// The answer to a query echoes the query itself, so the token is not counted; what must never appear is the note's text or its name (a held note's name can be private too).
const leaksText = text => text.includes('sample.person') || text.includes('note to self');
const leaks = text => leaksText(text) || text.includes('college-mail');
let server;
try {
  server = run(oldServer); await initialize(server); await setupToReady(server);
  const indexRows = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  assert(indexRows.includes('college-mail.md'), `precondition: 0.1.37 indexed the login-shape note:\n${indexRows}`);
  assert.notEqual(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%college-mail%'"), '0', 'precondition: in fts.db');
  server.child.kill('SIGTERM'); await sleep(1500);
  const noteFile = path.join(await fs.realpath(docs), 'college-mail.md');
  if (scenario !== 'start') await fs.writeFile(statePath, JSON.stringify({ ...(await state()), stage: scenario === 'stage' ? 'indexing' : 'taxonomy pending' }));

  // The re-screen is slowed (test hook) so the first questions arrive while it is still running.
  server = run(newServer, scenario === 'refresh' ? { DATABRAIN_TEST_INDEX_DELAY_MS: '6000' } : { DATABRAIN_TEST_UPDATE_DELAY_MS: '6000' }); await initialize(server);
  // Start trigger: with NO tool call at all, the re-screen must already be running a moment after the server started.
  await sleep(1500);
  if (scenario === 'refresh') {
    console.log('databrain_refresh: ' + (await server.tool('databrain_refresh')).slice(0, 160));
    await until(async () => (await state()).stage === 'indexing', 'the manual refresh is running', 60000);
  }
  const timing = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '');
  if (scenario === 'start') assert(timing.split('\n').some(line => /\trefresh\t[^\t]*\tjob-start\t/.test(line)), `the re-screen started at server start, before any question:\n${timing}`);
  const first = await server.tool('databrain_search', { query: 'upgradeprivatemarker' });
  console.log('=== FIRST SEARCH (note only the new rules hold) ===\n' + first + '\n=== END ===');
  const firstAbstain = await server.tool('databrain_abstain_check', { queries: ['upgradeprivatemarker', SECRET] });
  console.log('=== FIRST ABSTAIN CHECK ===\n' + firstAbstain + '\n=== END ===');
  const firstRead = await server.tool('databrain_read', { path: noteFile });
  console.log('=== FIRST READ ===\n' + firstRead + '\n=== END ===');
  assert(first.includes('re-checking your files'), `the first search says the re-check is running:\n${first}`);
  assert(!leaks(first), 'FIRST search returned private text');
  assert(!leaks(firstAbstain), 'FIRST abstain check returned private text');
  assert(!leaksText(firstRead), 'FIRST read returned private text');
  if (scenario === 'stage') { console.log('PASS upgrade privacy gate at stage indexing'); process.exitCode = 0; }
  else {
  await until(async () => { const st = await state(); return st.privacyRulesVersion === '0.1.38' && (scenario === 'start' || st.stage === 'ready'); }, 'rules version recorded and the refresh finished', 240000);
  if (scenario === 'start') await idle(server); else await sleep(1500);
  const after = await server.tool('databrain_search', { query: 'upgradeprivatemarker' });
  assert(!leaks(after), `after the re-screen the note is held:\n${after}`);
  assert.equal(sqlite(path.join(dataHome, 'moc', 'fts.db'), "SELECT count(*) FROM notes WHERE path LIKE '%college-mail%'"), '0', 'out of fts.db after the re-screen');
  const ordinary = await server.tool('databrain_search', { query: 'upgradeordinarymarker' });
  assert(ordinary.includes('plan.md'), `an ordinary note is still found:\n${ordinary}`);
  console.log('PASS upgrade privacy first search');
  }
} finally {
  server?.child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
