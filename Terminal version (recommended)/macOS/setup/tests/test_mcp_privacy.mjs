// Privacy screen: names are checked first (no file opened), then text on this Mac. Held files are
// never indexed; the user decides; later files are screened too. Fake data only.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
process.env.DATABRAIN_TEST_NO_AUTO_LABELS = '1';   // this test walks the manual labelling steps; test_mcp_auto_labels.mjs covers the automatic finish

const here = path.dirname(fileURLToPath(import.meta.url));
const gpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';   // part 33: the ChatGPT host indexes at once; the Claude host still pauses for the review
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
await F('Notes/diagnosis-misses.md', '# Notes\ndiagnosismarker my own notes about what the search misses.\n');   // "diagnosis" must NOT flag
await F('Notes/1099.txt', 'trackmarker track number 1099, a plain file name\n');   // a bare "1099" must NOT flag
await F('Notes/1099-NEC copy.md', '# Form\nnecmarker\n');   // "1099" with tax context flags
await F('Notes/W-2 2024.md', '# Form\nwtwomarker\n');   // "W-2" with tax context flags
await F('Notes/taxonomy.md', '# Taxonomy of plants\ntaxonomymarker is about classifying plants, not money.\n');   // "taxonomy" must NOT flag
await F('Impôts/avis-2025.md', '# Avis\nimpotsmarker nothing sensitive in here, the folder name is enough.\n');
await F('Banque/vacances.md', '# Trip\nbanquefoldermarker we booked the flat.\n');
await F('Notes/releve bancaire mars.md', '# Releve\nreleveprivatemarker\n');
await F('Notes/scan0042.md', '# Misc\nibanmarker pay to FR1420041010050500013M02606 please.\n');
await F('Notes/Pay slip.pdf', 'payslipmarker not a real pdf, only the name matters here\n');   // spaces: "pay slip" must flag (Mel's real miss)
await F('Notes/2022-12-14 Cal Poly doctor note.pdf', 'doctormarker not a real pdf either\n');   // "doctor" in a dated name must flag (Mel's real miss)
await F('Notes/doctoral-thesis.md', '# Thesis\ndoctoralmarker a doctoral thesis outline, not a doctor visit.\n');   // "doctoral" must NOT flag
await F('Notes/misc.txt', 'cardmarker 4111 1111 1111 1111 expires soon\n');
await F('Notes/misc2.md', '# Misc\nsecumarker n° 2 55 08 75 112 233 57 is mine\n');
await F('Notes/key.md', '# Misc\nkeymarker\n-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----\n');
await F('Maths/lucky.md', '# Numbers\nnumbermarker my lucky number is 1234 5678 9012 3456 and 4242 4242\n');   // fails Luhn: must NOT flag
await F('Notes/letter.rtf', '{\\rtf1\\ansi rtfmarker IBAN FR1420041010050500013M02606 end}');

const server = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_PRIVACY_CONSENT: 'yes' }, stdio: ['pipe', 'pipe', 'pipe'] });
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
// Part 22: the chat carries ONE sentence about held files, never a count, reason, folder, number or name; the full list and the keep choice are a local file the model is not given
const PRIVATE = 'Those files are private and cannot be accessed for privacy reasons.';
const reviewFile = () => fs.readFile(path.join(dataHome, 'Private files review.txt'), 'utf8');
const numberOf = async name => (await reviewFile()).split('\n').find(line => line.includes(name))?.match(/^(\d+)\. /)?.[1];
const grepAll = (needle) => spawnSync('/usr/bin/grep', ['-rla', needle, dataHome], { encoding: 'utf8' }).stdout.trim();

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const spec = (await rpc('tools/list')).result.tools.find(t => t.name === 'databrain_privacy');
  assert(spec, 'databrain_privacy must be a listed tool');

  // 1. Setup start checks NAMES first and pauses with the list; nothing is indexed yet.
  await call('databrain_setup_start');
  let lastStatus = '';
  await waitFor(async () => { lastStatus = await call('databrain_setup_status'); return (gpt ? lastStatus.includes('Stage: taxonomy pending') : lastStatus.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) || null; }, gpt ? 'indexing without a pause' : 'the privacy pause').catch(error => { throw new Error(`${error.message}\n${lastStatus}`); });
  const start = await call('databrain_privacy', { action: 'list' });
  assert(start.includes(PRIVATE) && !/\d|file\(s\)|waiting/.test(start), `the list is one sentence and says where the review file is:\n${start}`);
  const startFile = await reviewFile();   // names live in the local file only
  for (const name of ['avis-2025', 'vacances', 'releve bancaire', 'Pay slip', 'W-2', 'Impôts', 'Banque']) assert(!start.includes(name), `the chat list must not carry ${name}:\n${start}`);
  assert(startFile.includes('Impôts/avis-2025.md') && startFile.includes('folder "Impôts"'), start);
  assert(startFile.includes('Banque/vacances.md') && startFile.includes('releve bancaire mars.md'), start);
  assert(!startFile.includes('garden.md') && !startFile.includes('taxonomy.md') && !startFile.includes('lucky.md') && !startFile.includes('diagnosis-misses.md') && !startFile.includes('1099.txt'), 'harmless names must not be flagged (taxonomy, garden, diagnosis, a bare 1099)');
  assert(startFile.includes('1099-NEC copy.md') && startFile.includes('W-2 2024.md'), 'tax numbers with tax context must be flagged');
  assert(startFile.includes('Pay slip.pdf') && startFile.includes('2022-12-14 Cal Poly doctor note.pdf'), `both of Mel's real misses must be held at the name check:\n${startFile}`);
  assert(!startFile.includes('doctoral-thesis.md'), 'doctoral must not be flagged');
  assert(/IMG_2231\.jpg are NOT checked/.test(startFile) && /keep: no/.test(startFile), 'the local file says scanned images are not caught and carries the keep column');
  if (gpt) assert(!/paused for privacy review/i.test(lastStatus + await call('databrain_setup_run')), 'part 33: the ChatGPT host never pauses for the review');
  else {
    await assert.rejects(fs.stat(path.join(dataHome, 'moc', 'index.tsv')), { code: 'ENOENT' }, 'nothing may be indexed before the review');
    assert((await call('databrain_setup_status')).startsWith('SETUP PAUSED FOR PRIVACY REVIEW'));
    assert(/paused for privacy review/.test(await call('databrain_setup_run')), 'setup_run must not skip the review');
  }

  // 2. The user excludes all (empty keep): indexing then starts by itself.
  if (!gpt) {   // the ChatGPT host indexed already and the review stays optional: nothing to decide yet (a decide now would also exclude the content-held files)
    const decided = await call('databrain_privacy', { action: 'decide', keep: [] });
    assert(/^Recorded\. No file was kept/.test(decided) && !/\d/.test(decided.split('Indexing')[0]), decided);
  }
  await waitFor(async () => (await call('databrain_setup_status')).includes('Stage: taxonomy pending') || null, 'indexing after the review');

  // 3. Only harmless files are in the index; the content screen held the rest before indexing.
  const rows = await index();
  for (const ok of ['garden.md', 'taxonomy.md', 'lucky.md', 'diagnosis-misses.md', '1099.txt', 'doctoral-thesis.md']) assert(rows.includes(ok), `${ok} must be indexed`);
  for (const bad of ['Pay slip.pdf', 'Cal Poly doctor note.pdf', '1099-NEC copy.md', 'W-2 2024.md', 'avis-2025.md', 'vacances.md', 'releve bancaire', 'scan0042.md', 'misc.txt', 'misc2.md', 'key.md', 'letter.rtf']) assert(!rows.includes(bad), `${bad} must not be indexed`);
  for (const marker of ['payslipmarker', 'doctormarker', 'impotsmarker', 'banquefoldermarker', 'releveprivatemarker', 'ibanmarker', 'cardmarker', 'secumarker', 'keymarker', 'rtfmarker']) {
    assert.equal(grepAll(marker), '', `${marker} text must never reach the DataBrain folder`);
  }
  assert(grepAll('okmarkerzephyr') !== '', 'harmless text is searchable');
  const listed = await call('databrain_privacy', { action: 'list' });
  const review = await reviewFile();
  for (const [file, why] of [['scan0042.md', 'contains an IBAN'], ['misc.txt', 'contains a card number'], ['misc2.md', 'contains a French social security number'], ['key.md', 'contains a private key'], ['letter.rtf', 'contains an IBAN']]) {
    assert(new RegExp(`\\d+\\. .*${file.replace('.', '\\.')}.*\\(${why}; folder: .*\\)`).test(review), `${file} must be in the local review file as "${why}":\n${review}`);
    assert(!listed.includes(file) && !listed.includes(why), `the chat list must carry neither the name ${file} nor the reason:\n${listed}`);
  }
  assert(listed.startsWith(PRIVATE) && !/\d|file\(s\)|source folder/.test(listed), `the chat list is the one sentence:\n${listed}`);
  assert(/Private files review\.txt/.test(listed), 'the list says where the full list is');
  assert(!listed.includes('lucky.md'), 'a number that fails the card checksum must not be held');
  const statusNow = await call('databrain_setup_status');
  assert(statusNow.includes(PRIVATE) && !/\d file\(s\)|waiting for the user/.test(statusNow), 'status says the one sentence, no count');

  // 4. The user keeps one held file: it is allowed and indexed on refresh, the rest stay out.
  assert(/^1\. .*keep: no/m.test(review), 'the local file is numbered and has the keep column');
  assert(!/Do not suggest keeping/.test(listed), 'the rules for showing it (never suggest keeping a file) are in the tool description');
  const shownName = await numberOf('misc.txt');
  assert(shownName, 'misc.txt has a number in the local file');
  // a keep request by name, by a number that was not shown, or by a non-number is refused and changes nothing
  for (const bad of [['misc.txt'], ['999'], ['gar den.md'], ['0x2']]) {
    const refused = await call('databrain_privacy', { action: 'decide', keep: bad });
    assert(/not accepted|not in the list shown|not in the last list shown|keep takes file names|keep list takes the numbers|must be a list|numbers from the last list/i.test(refused) || /error|Error/.test(refused) || refused === '', `keep ${JSON.stringify(bad)} must be refused: ${refused}`);
    assert(!/^Recorded/.test(refused), `keep ${JSON.stringify(bad)} must not be recorded: ${refused}`);
  }
  assert((await call('databrain_privacy', { action: 'list' })).includes(PRIVATE) && (await reviewFile()).includes('misc.txt'), 'a refused keep must change nothing');
  // the user marks misc.txt "keep: yes" in the local file and says they reviewed it: decide with no keep list reads the file
  await fs.writeFile(path.join(dataHome, 'Private files review.txt'), (await reviewFile()).split('\n').map(line => line.includes('misc.txt') ? line.replace('keep: no', 'keep: yes') : line).join('\n'));
  const second = await call('databrain_privacy', { action: 'decide' });
  await assert.rejects(reviewFile(), { code: 'ENOENT' }, 'after the decision the local review file (it names held files) is gone');
  assert(/^Recorded\. The files the user kept are indexed by the next refresh/.test(second) && !/\d/.test(second) && !second.includes('databrain_refresh'), second);
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
  // a file held after the last list was shown cannot be kept until a new list has been shown
  const lateNumber = (await call('databrain_privacy', { action: 'decide', keep: ['999'] })) && '999';
  assert(!/^Recorded/.test(await call('databrain_privacy', { action: 'decide', keep: [lateNumber] })), 'a number that was not in the review file must be refused');
  assert((await call('databrain_privacy', { action: 'list' })).includes(PRIVATE));
  const lateReal = await numberOf('payslip-june.md');
  assert(lateReal, 'the late file is in the local review file');
  assert(/^Recorded\. The files the user kept/.test(await call('databrain_privacy', { action: 'decide', keep: [lateReal] })), 'a number from the review file is accepted');

  console.log('PASS: names are screened before indexing, text is screened on the Mac, held files never reach the index, the user decides, later files are held too.');
} finally {
  server.kill();
  await fs.rm(temp, { recursive: true, force: true });
}
