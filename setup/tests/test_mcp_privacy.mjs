// Privacy screen: names are checked first (no file opened), then text on this Mac. Held files are
// never indexed; the user decides; later files are screened too. Fake data only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-privacy-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
const dataHome = path.join(home, 'DataBrain');
await fs.mkdir(path.join(docs, 'Impôts'), { recursive: true });
await fs.mkdir(path.join(docs, 'Notes'), { recursive: true });
await fs.mkdir(path.join(docs, 'Banque'), { recursive: true });
await fs.mkdir(path.join(docs, 'Maths'), { recursive: true });
const F = (rel, text) => fs.writeFile(path.join(docs, rel), text);
await F('Notes/garden.md', '# Garden\nokmarkerzephyr tomatoes need staking in June.\n');
await F('Notes/taxonomy.md', '# Taxonomy of plants\ntaxonomymarker is about classifying plants, not money.\n');   // "taxonomy" must NOT flag
await F('Impôts/avis-2025.md', '# Avis\nimpotsmarker nothing sensitive in here, the folder name is enough.\n');
await F('Banque/vacances.md', '# Trip\nbanquefoldermarker we booked the flat.\n');
await F('Notes/releve bancaire mars.md', '# Releve\nreleveprivatemarker\n');
await F('Notes/scan0042.md', '# Misc\nibanmarker pay to FR1420041010050500013M02606 please.\n');
await F('Notes/misc.txt', 'cardmarker 4111 1111 1111 1111 expires soon\n');
await F('Notes/misc2.md', '# Misc\nsecumarker n° 2 55 08 75 112 233 57 is mine\n');
await F('Notes/key.md', '# Misc\nkeymarker\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
await F('Maths/lucky.md', '# Numbers\nnumbermarker my lucky number is 1234 5678 9012 3456 and 4242 4242\n');   // fails Luhn: must NOT flag
await F('Notes/letter.rtf', '{\\rtf1\\ansi rtfmarker IBAN FR1420041010050500013M02606 end}');

const server = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const replies = new Map();
readline.createInterface({ input: server.stdout }).on('line', line => { const m = JSON.parse(line); replies.get(m.id)?.(m); });
let nextId = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 60000);
  replies.set(id, m => { clearTimeout(timer); resolve(m); });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label, limitMs = 120000) {
  const start = Date.now();
  for (;;) { const v = await check(); if (v) return v; assert(Date.now() - start < limitMs, `timed out waiting for ${label}`); await sleep(300); }
}
const index = async () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const grepAll = (needle) => spawnSync('/usr/bin/grep', ['-rla', needle, dataHome], { encoding: 'utf8' }).stdout.trim();

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const spec = (await rpc('tools/list')).result.tools.find(t => t.name === 'databrain_privacy');
  assert(spec, 'databrain_privacy must be a listed tool');

  // 1. Setup start checks NAMES first and pauses with the list; nothing is indexed yet.
  await call('databrain_setup_start');
  let lastStatus = '';
  await waitFor(async () => { lastStatus = await call('databrain_setup_status'); return lastStatus.startsWith('SETUP PAUSED FOR PRIVACY REVIEW') || null; }, 'the privacy pause').catch(error => { throw new Error(`${error.message}\n${lastStatus}`); });
  const start = await call('databrain_privacy', { action: 'list' });
  assert(/look private and are held back/.test(start), start);
  assert(start.includes('Impôts/avis-2025.md') && start.includes('folder "Impôts"'), start);
  assert(start.includes('Banque/vacances.md') && start.includes('releve bancaire mars.md'), start);
  assert(!start.includes('garden.md') && !start.includes('taxonomy.md') && !start.includes('lucky.md'), 'harmless names must not be flagged (taxonomy, garden)');
  assert(/IMG_2231\.jpg are NOT checked/.test(start), 'the list must say scanned images are not caught');
  await assert.rejects(fs.stat(path.join(dataHome, 'moc', 'index.tsv')), { code: 'ENOENT' }, 'nothing may be indexed before the review');
  assert((await call('databrain_setup_status')).startsWith('SETUP PAUSED FOR PRIVACY REVIEW'));
  assert(/look private and are held back/.test(await call('databrain_setup_run')), 'setup_run must not skip the review');

  // 2. The user excludes all (empty keep): indexing then starts by itself.
  const decided = await call('databrain_privacy', { action: 'decide', keep: [] });
  assert(/3 excluded \(never read\), 0 allowed/.test(decided), decided);
  await waitFor(async () => (await call('databrain_setup_status')).includes('Stage: taxonomy pending') || null, 'indexing after the review');

  // 3. Only harmless files are in the index; the content screen held the rest before indexing.
  const rows = await index();
  for (const ok of ['garden.md', 'taxonomy.md', 'lucky.md']) assert(rows.includes(ok), `${ok} must be indexed`);
  for (const bad of ['avis-2025.md', 'vacances.md', 'releve bancaire', 'scan0042.md', 'misc.txt', 'misc2.md', 'key.md', 'letter.rtf']) assert(!rows.includes(bad), `${bad} must not be indexed`);
  for (const marker of ['impotsmarker', 'banquefoldermarker', 'releveprivatemarker', 'ibanmarker', 'cardmarker', 'secumarker', 'keymarker', 'rtfmarker']) {
    assert.equal(grepAll(marker), '', `${marker} text must never reach the DataBrain folder`);
  }
  assert(grepAll('okmarkerzephyr') !== '', 'harmless text is searchable');
  const listed = await call('databrain_privacy', { action: 'list' });
  for (const [file, why] of [['scan0042.md', 'contains an IBAN'], ['misc.txt', 'contains a card number'], ['misc2.md', 'contains a French social security number'], ['key.md', 'contains a private key'], ['letter.rtf', 'contains an IBAN']]) {
    assert(new RegExp(`${file.replace('.', '\\.')} \\(${why}\\)`).test(listed), `${file} must be held as "${why}":\n${listed}`);
  }
  assert(!listed.includes('lucky.md'), 'a number that fails the card checksum must not be held');
  assert((await call('databrain_setup_status')).includes('Held back for privacy review: 5'));

  // 4. The user keeps one held file: it is allowed and indexed on refresh, the rest stay out.
  const items = listed.split('\n').filter(line => /^\d+\. /.test(line));
  const number = Number(items.find(line => line.includes('misc.txt')).split('.')[0]);
  const second = await call('databrain_privacy', { action: 'decide', keep: [number] });
  assert(/4 excluded \(never read\), 1 allowed/.test(second) && second.includes('databrain_refresh'), second);
  await call('databrain_refresh');
  await waitFor(async () => (await index()).includes('misc.txt') || null, 'allowed file indexed');
  assert(!(await index()).includes('scan0042.md'));

  // 5. A new private file added later is held too, never indexed.
  await waitFor(async () => (await call('databrain_setup_status')).includes('Stage: taxonomy pending') || null, 'the refresh to finish');
  await F('Notes/payslip-june.md', '# Pay\nlatermarker\n');
  await F('Notes/later.md', '# Later\nlaterokmarker hello\n');
  await call('databrain_refresh');
  await waitFor(async () => (await index()).includes('later.md') || null, 'later harmless file indexed');
  assert(!(await index()).includes('payslip-june.md') && grepAll('latermarker') === '', 'a new private-looking file must be held, not indexed');
  assert(/payslip-june\.md/.test(await call('databrain_privacy', { action: 'list' })));
  await assert.rejects(call('databrain_privacy', { action: 'decide', keep: [99] }).then(t => { if (!/no held file number/.test(t)) throw new Error('bad'); throw new Error(t); }), /no held file number|bad/);

  console.log('PASS: names are screened before indexing, text is screened on the Mac, held files never reach the index, the user decides, later files are held too.');
} finally {
  server.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
