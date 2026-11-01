// A note that was clean when it was indexed and is edited afterwards to hold an IBAN, a card number or a labelled password is screened again,
// in the fast refresh and in the full refresh alike: it leaves the index and the search database and is held for the user's review, the same
// way a new private file is. A note the user already decided to keep keeps that decision. An ordinary edit still goes through.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const IBAN = 'FR1420041010050500013M02606';

async function scenario(path_) {
  const full = path_ === 'full refresh';
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-rescreen-')));
  const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const root = await fs.realpath(docs);
  const dataHome = path.join(home, 'DataBrain');
  for (const name of ['alpha', 'bravo', 'charlie', 'delta']) await fs.writeFile(path.join(root, `${name}.md`), `# ${name}\nrescreen${name}base an ordinary note.\n`);   // neutral names: only the text can give them away
  await fs.writeFile(path.join(root, 'kept.md'), `# Kept\nrescreenkeptbase my iban is ${IBAN}\n`);   // held at setup; the user keeps it
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(root, `steady-${i}.md`), `# Steady ${i}\nrescreensteady${i} ordinary.\n`);
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', root], { env: { ...process.env, HOME: home, DATABRAIN_TEST_PRIVACY_CONSENT: 'yes', DATABRAIN_FRESHNESS_CHECK_MS: '100', ...(full ? { DATABRAIN_TEST_FAST_REFRESH_MAX: '-1' } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const timing = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => l.split('\t'));
  const refreshSteps = async from => { const rows = (await timing()).slice(from); const ids = [...new Set(rows.filter(f => f[1] === 'refresh' && f[3] === 'job-start').map(f => f[2]))]; return ids.map(id => rows.filter(f => f[2] === id && /^engine:/.test(f[3])).map(f => f[3].replace('engine:', ''))); };
  const rowFor = async name => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).split('\n').some(line => line.split('\t')[0].endsWith(`/${name}`));
  const inDatabase = word => spawnSync('/usr/bin/sqlite3', ['-readonly', path.join(dataHome, 'moc', 'fts.db'), `SELECT count(*) FROM notes WHERE notes MATCH '${word}'`], { encoding: 'utf8' }).stdout.trim();
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await tool('databrain_setup_start');
    await until(async () => {
      const status = await tool('databrain_setup_status');
      if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
      return /Stage: ready\./.test(status);
    }, `${path_}: setup reaches ready`);
    for (const name of ['alpha', 'bravo', 'charlie', 'delta']) assert(await rowFor(`${name}.md`), `${name}.md is indexed at setup`);
    // the note with an IBAN was held at setup; the user reviews the list and keeps it. A kept file is indexed by the next refresh, which the first question brings
    const listed = await tool('databrain_privacy', { action: 'list' });
    assert(/kept\.md/.test(listed) && !/alpha\.md|bravo\.md|charlie\.md|delta\.md/.test(listed), `only the IBAN note was held at setup:\n${listed}`);
    assert(/Recorded: .* 1 allowed/.test(await tool('databrain_privacy', { action: 'decide', keep: ['kept.md'] })), 'the user keeps it');
    await sleep(300);
    await tool('databrain_search', { query: 'rescreenkeptbase' });
    await until(() => rowFor('kept.md'), `${path_}: the note the user kept is indexed`, 60000);
    await sleep(1500);

    // the edits: three clean notes now hold private text, one gets an ordinary addition, the kept note gets another IBAN
    const mark = (await timing()).length;
    await fs.appendFile(path.join(root, 'alpha.md'), `\nrescreenibanword my iban is ${IBAN}\n`);
    await fs.appendFile(path.join(root, 'bravo.md'), '\nrescreencardword my card is 4111 1111 1111 1111\n');
    await fs.appendFile(path.join(root, 'charlie.md'), '\nrescreenpassword the wifi password: hunter22xyz\n');
    await fs.appendFile(path.join(root, 'delta.md'), '\nrescreenokword an ordinary addition.\n');
    await fs.appendFile(path.join(root, 'kept.md'), `\nrescreenkeptword another iban ${IBAN}\n`);
    await sleep(300);
    const ok = await tool('databrain_search', { query: 'rescreenokword' });
    assert(/delta\.md/.test(ok), `${path_}: an ordinary edit is searchable in the first answer:\n${ok}`);
    const steps = await refreshSteps(mark);
    assert.equal(steps.length, 1, `${path_}: one refresh: ${JSON.stringify(steps)}`);
    assert.equal(steps[0].includes('inventory.sh'), full, `${path_}: ${full ? 'the full refresh ran' : 'the fast refresh ran (no inventory in the update)'}: ${steps[0]}`);

    for (const [word, file] of [['rescreenibanword', 'alpha.md'], ['rescreencardword', 'bravo.md'], ['rescreenpassword', 'charlie.md']]) {
      const found = await tool('databrain_search', { query: word });
      assert(!found.includes(file), `${path_}: ${file} (edited to hold private text) must not be searchable:\n${found}`);
      assert(!(await rowFor(file)), `${path_}: ${file} has no row in the index`);
      assert.equal(inDatabase(word), '0', `${path_}: ${word} is not in the search database`);
      assert.equal(inDatabase(`rescreen${file.replace('.md', '')}base`), '0', `${path_}: the rest of ${file} left the search database too`);
    }
    const held = await tool('databrain_privacy', { action: 'list' });
    for (const file of ['alpha.md', 'bravo.md', 'charlie.md']) assert(held.includes(file), `${path_}: ${file} is on the held list:\n${held}`);
    assert(!held.includes('delta.md'), `${path_}: the ordinary note is not held`);
    // the user's earlier decision stands
    assert(/kept\.md/.test(await tool('databrain_search', { query: 'rescreenkeptword' })), `${path_}: the note the user chose to keep stays indexed after another edit`);
    assert(await rowFor('kept.md'), `${path_}: kept.md still has its row`);
    // nothing is stale afterwards
    await sleep(300);
    const later = (await timing()).length;
    await tool('databrain_search', { query: 'rescreensteady1' });
    assert.equal((await refreshSteps(later)).length, 0, `${path_}: no second refresh`);
  } finally {
    child.kill('SIGKILL');
    await sleep(800);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

await scenario('fast refresh');
await scenario('full refresh');
console.log('PASS: in the fast and in the full refresh, a clean note edited to hold an IBAN, a card number or a labelled password leaves the index and the search database and is held; an ordinary edit is found; a note the user chose to keep stays kept.');
