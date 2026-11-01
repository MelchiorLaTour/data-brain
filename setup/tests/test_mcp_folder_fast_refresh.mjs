// A changed, new, deleted or renamed note in an approved folder is applied by touching ONLY those rows, like an app page:
// no walk of the folder, no inventory and no room pages in the update itself (they follow in the background), and the first answer already has
// the change. Every privacy and folder rule still runs on the changed rows: private names and private text (in a note and inside a Word file),
// a pruned folder, a link to a file outside, and other file types never become searchable. A big change (more than the limit) still takes the full refresh.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-ffast-')));
const home = path.join(temp, 'home');
await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const docs = path.join(temp, 'Documents'); await fs.mkdir(path.join(docs, 'sub'), { recursive: true });
const root = await fs.realpath(docs);
const outside = path.join(temp, 'outside'); await fs.mkdir(outside);
await fs.writeFile(path.join(outside, 'secret.md'), 'ffoutsidemarker lives outside the approved folder\n');
for (let i = 0; i < 12; i++) await fs.writeFile(path.join(root, i % 2 ? 'sub' : '.', `steady-${i}.md`), `# Steady ${i}\nffsteady${i}marker an ordinary note.\n`);
await fs.writeFile(path.join(root, 'sub', 'tobedeleted.md'), '# Delete me\nffdeletemarker goes away.\n');
await fs.writeFile(path.join(root, 'sub', 'oldname.md'), '# Moving\nffrenamemarker keeps its words.\n');

const dataHome = path.join(home, 'DataBrain');
let n = 0;
function startServer(extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', root], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, tool, ready };
}
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;
const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
const jobSteps = async (kind, from = 0) => { const rows = (await timing()).slice(from); const ids = [...new Set(rows.filter(f => f[1] === kind && f[3] === 'job-start').map(f => f[2]))]; return ids.map(id => ({ id, steps: rows.filter(f => f[2] === id && /^engine:/.test(f[3])).map(f => f[3].replace('engine:', '')) })); };
const indexText = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const hasRow = async name => (await indexText()).split('\n').some(line => line.split('\t')[0].endsWith(`/${name}`));
const FAST = /^(ingest-root|prune-missing|extract|build-fts)\.sh$/;
async function settle() { await until(async () => (await timing()).filter(f => f[1] === 'index housekeeping' && f[3] === 'job-start').length === (await timing()).filter(f => f[1] === 'index housekeeping' && f[3] === 'job-end').length, 'housekeeping idle', 180000); await sleep(400); }
// one change, then one search: the first answer must already have it; returns the refresh job's steps
async function change(label, apply, query) {
  await settle();
  const mark = (await timing()).length;
  await apply();
  await sleep(300);
  const answer = await server.tool('databrain_search', { query });
  const jobs = await jobSteps('refresh', mark);
  return { answer, jobs, mark, label };
}
const servers = [];
let server;
try {
  server = startServer(); servers.push(server);
  await server.ready; await server.tool('databrain_setup_start');
  await until(async () => {
    const status = await server.tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
    return (await savedStage().catch(() => '')) === 'ready';
  }, 'setup reaches ready');
  assert(await hasRow('steady-3.md') && await hasRow('oldname.md'), 'setup indexed the notes');

  // 1. one edited note
  let r = await change('edit', () => fs.appendFile(path.join(root, 'sub', 'steady-3.md'), '\nffeditmarker added after setup.\n'), 'ffeditmarker');
  assert(/steady-3\.md/.test(r.answer), `the edited note is in the first answer:\n${r.answer}`);
  assert.equal(r.jobs.length, 1, `one refresh: ${JSON.stringify(r.jobs)}`);
  assert.deepEqual(r.jobs[0].steps.filter(s => !FAST.test(s)), [], `an edit touches only its own row, no walk, inventory or room pages: ${r.jobs[0].steps}`);
  assert(r.jobs[0].steps.includes('build-fts.sh') && !r.jobs[0].steps.includes('ingest-root.sh') && !r.jobs[0].steps.includes('prune-missing.sh'), `an edit needs no ingest or prune: ${r.jobs[0].steps}`);

  // 2. one new note
  r = await change('new', () => fs.writeFile(path.join(root, 'sub', 'brandnew.md'), '# Brand new\nffnewmarker a new note.\n'), 'ffnewmarker');
  assert(/brandnew\.md/.test(r.answer), `the new note is in the first answer:\n${r.answer}`);
  assert.deepEqual(r.jobs[0].steps.filter(s => !FAST.test(s)), [], `a new note touches only its own row: ${r.jobs[0].steps}`);
  assert.equal(r.jobs[0].steps.filter(s => s === 'ingest-root.sh').length, 1, 'one ingest, of the new file only');
  assert(await hasRow('brandnew.md'), 'the new note has its row');

  // 3. one deleted note
  r = await change('delete', () => fs.rm(path.join(root, 'sub', 'tobedeleted.md')), 'ffdeletemarker');
  assert(!/tobedeleted\.md/.test(r.answer), `the deleted note is gone from the first answer:\n${r.answer}`);
  assert.deepEqual(r.jobs[0].steps.filter(s => !FAST.test(s)), [], `a deletion touches only its own row: ${r.jobs[0].steps}`);
  assert(r.jobs[0].steps.includes('prune-missing.sh'), 'the row is dropped');
  assert(!(await hasRow('tobedeleted.md')), 'the deleted note lost its row');

  // 4. one renamed note: the old name is gone, the new name has the same words
  r = await change('rename', () => fs.rename(path.join(root, 'sub', 'oldname.md'), path.join(root, 'sub', 'newname.md')), 'ffrenamemarker');
  assert(/newname\.md/.test(r.answer) && !/oldname\.md/.test(r.answer), `the renamed note is found under its new name only:\n${r.answer}`);
  assert.deepEqual(r.jobs[0].steps.filter(s => !FAST.test(s)), [], `a rename touches only its two rows: ${r.jobs[0].steps}`);
  assert(await hasRow('newname.md') && !(await hasRow('oldname.md')), 'rows: new name in, old name out');

  // 5. privacy and folder rules on the changed rows
  await settle();
  await fs.mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  const heldNames = ['payslip-march.md'];
  await fs.writeFile(path.join(root, 'sub', 'payslip-march.md'), 'ffprivatenamemarker looks private by its name\n');
  await fs.writeFile(path.join(root, 'sub', 'plain-name.md'), 'ffprivatetextmarker my iban is FR1420041010050500013M02606\n');
  await fs.writeFile(path.join(root, 'node_modules', 'pkg', 'dep.md'), 'ffprunedmarker inside a pruned folder\n');
  await fs.writeFile(path.join(root, 'sub', 'photo.jpg'), 'ffjpgmarker not a read type\n');
  await fs.symlink(path.join(outside, 'secret.md'), path.join(root, 'sub', 'sneaky.md'));
  await fs.writeFile(path.join(root, 'sub', 'fine-new.md'), '# Fine\nffokmarker an ordinary new note next to the private ones.\n');
  const haveTextutil = spawnSync('/usr/bin/textutil', ['-help'], { stdio: 'ignore' }).status !== null;
  if (haveTextutil) {
    await fs.writeFile(path.join(temp, 'statement.txt'), 'ffworddocmarker Account IBAN FR1420041010050500013M02606\n');
    assert.equal(spawnSync('/usr/bin/textutil', ['-convert', 'docx', '-output', path.join(root, 'sub', 'statement.docx'), path.join(temp, 'statement.txt')]).status, 0, 'made a Word file');
  }
  const mark = (await timing()).length;
  await sleep(300);
  const ok = await server.tool('databrain_search', { query: 'ffokmarker' });
  assert(/fine-new\.md/.test(ok), `the ordinary new note is searchable in the first answer:\n${ok}`);
  const jobs = await jobSteps('refresh', mark);
  assert.deepEqual(jobs[0].steps.filter(s => !FAST.test(s)), [], `still the fast path: ${jobs[0].steps}`);
  await settle();
  for (const [word, file, why] of [['ffprivatenamemarker', 'payslip-march', 'a private-looking name'], ['ffprivatetextmarker', 'plain-name', 'private text in a note'], ['ffprunedmarker', 'dep.md', 'a pruned folder'], ['ffjpgmarker', 'photo.jpg', 'a file type that is not read'], ['ffoutsidemarker', 'secret.md', 'a link to a file outside the approved folder']]) {
    const found = await server.tool('databrain_search', { query: word });
    assert(!found.includes(file) && !found.includes('sneaky'), `${why} must not be searchable:\n${found}`);
  }
  const idx = await indexText();
  for (const name of ['payslip-march.md', 'plain-name.md', 'dep.md', 'photo.jpg', 'sneaky.md', 'secret.md']) assert(!idx.split('\n').some(l => l.split('\t')[0].endsWith(`/${name}`)), `${name} has no row`);
  const held = await server.tool('databrain_privacy', { action: 'list' });
  assert(/payslip-march\.md/.test(held) && /plain-name\.md/.test(held), `the private name and the private text are on the held list:\n${held}`);
  if (haveTextutil) {
    assert(!(await hasRow('statement.docx')), 'a Word file holding an IBAN is held back after it is read, and its row is dropped');
    assert(/statement\.docx/.test(held), `the Word file is on the held list:\n${held}`);
    assert(!(await server.tool('databrain_search', { query: 'ffworddocmarker' })).includes('statement.docx'), 'the Word file text is not searchable');
  }

  // 6. the tidying follows by itself, and the baseline is current (no second refresh)
  await settle();
  assert((await timing()).some(f => f[1] === 'index housekeeping' && f[3] === 'engine:inventory.sh'), 'inventory and room pages ran in the background');
  const quiet = (await timing()).length; await sleep(300);
  await server.tool('databrain_search', { query: 'ffsteady3marker' });
  assert.equal((await jobSteps('refresh', quiet)).length, 0, 'nothing is stale afterwards');

  // 7. more changes than the limit take the full refresh (walk, inventory, room pages)
  server.child.kill('SIGKILL'); await sleep(1000);
  server = startServer({ DATABRAIN_TEST_FAST_REFRESH_MAX: '2' }); servers.push(server); await server.ready;
  await sleep(500);
  const bigMark = (await timing()).length;
  for (const i of [1, 2, 3]) await fs.appendFile(path.join(root, `steady-${i * 2}.md`), `\nffbigmarker${i} edited.\n`);
  await sleep(300);
  const big = await server.tool('databrain_search', { query: 'ffbigmarker1' });
  const bigJobs = await jobSteps('refresh', bigMark);
  assert(bigJobs.length >= 1 && bigJobs[0].steps.includes('inventory.sh') && bigJobs[0].steps.includes('rebuild.sh'), `three changes with a limit of two take the full refresh: ${JSON.stringify(bigJobs)}`);
  assert(/steady-2\.md/.test(big) || /steady-2\.md/.test(await server.tool('databrain_search', { query: 'ffbigmarker1' })), 'and the change is still found');

  console.log('PASS: an edited, a new, a deleted and a renamed note are each applied by touching only their own rows (no walk, no inventory, no room pages; those follow in the background) and are in the first answer; private names, private text (note and Word file), a pruned folder, a link outside and other file types never become searchable; more than the limit takes the full refresh.');
} finally {
  for (const x of servers) x.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
