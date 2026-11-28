// Part 33 (ChatGPT host): the first setup never waits for the private-file review.
// Gate 1: first setup reaches indexing and ready with no review step; held-by-name files are absent from the index, the rest are present.
// Gate 2: a held file is never opened, read or extracted: the extractor stubs log every path they get, the marker text never reaches the brain folder.
// Gate 3: releasing one file (keep: yes in the review file + "I reviewed my private files") indexes exactly that file on the next refresh.
// Gate 4: the setup reply carries the private sentence, no held file name, and no "complete the review" / "paused" wording.
// Usage: node test_chatgpt_no_privacy_pause.mjs [engine root to stage from]   (a mutant tree can be passed)
// The engine is copied to a scratch folder; textutil/pdftotext stubs in its runtime/bin log their arguments, then run the real tool.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHome, startChatgpt, until } from './chatgpt-harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] || path.join(here, '..', '..'));
const PRIVATE = 'Those files are private and cannot be accessed for privacy reasons.';

const stage = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-nopause-stage-')));
await fs.cp(path.join(engine, 'bin'), path.join(stage, 'bin'), { recursive: true });
await fs.cp(path.join(engine, 'setup', 'mcp'), path.join(stage, 'setup', 'mcp'), { recursive: true });
await fs.mkdir(path.join(stage, 'setup', 'chatgpt'), { recursive: true });
await fs.copyFile(path.join(engine, 'setup', 'chatgpt', 'VERSION'), path.join(stage, 'setup', 'chatgpt', 'VERSION'));
const runtimeBin = path.join(stage, 'setup', 'mcp', 'runtime', 'bin');
await fs.mkdir(runtimeBin, { recursive: true });
const log = path.join(stage, 'extractor.log');
await fs.writeFile(log, '');
const stub = async (name, real) => {
  await fs.writeFile(path.join(runtimeBin, name), `#!/bin/bash\nprintf '%s\\t%s\\n' ${JSON.stringify(name)} "$(/usr/bin/shasum -a 256 "\${@: -1}" 2>/dev/null | cut -d' ' -f1)" >> ${JSON.stringify(log)}\n${real ? `exec ${real} "$@"` : 'exit 1'}\n`, { mode: 0o755 });
};
await stub('textutil', '/usr/bin/textutil');
await stub('pdftotext', null);   // the product falls back to its own PDF reader when this fails; the call is what we record
// The extractor is handed a temporary copy, so the stub logs the sha256 of the file it was given; the test compares with the sha256 of each note.
const extractorSeen = async () => new Set((await fs.readFile(log, 'utf8')).split('\n').filter(Boolean).map(line => line.split('\t')[1]));
const shaOf = async name => (await import('node:crypto')).createHash('sha256').update(await fs.readFile(path.join(notes, name))).digest('hex');

const env = await fakeHome('nopause');
const notes = path.join(env.home, 'Notes');
await fs.mkdir(notes, { recursive: true });
const textutilTo = (format, name, text) => {
  const src = path.join(env.temp, `${name}.src.txt`);
  return fs.writeFile(src, text).then(() => execFileSync('textutil', ['-convert', format, src, '-output', path.join(notes, name)]));
};
// harmless files (must be indexed)
await fs.writeFile(path.join(notes, 'Garden.md'), '# Garden\nTomatoes need staking. okgardenmarker\n');
await fs.writeFile(path.join(notes, 'Reading list.txt'), 'Three books for the winter. okreadingmarker\n');
await textutilTo('docx', 'Trip plan.docx', 'Pack light and take a paper map. oktripmarker');
// held by name (never opened, never read)
await fs.writeFile(path.join(notes, 'Tax return 2023.md'), '# Form\nheldtaxmarker nothing real here\n');
await fs.writeFile(path.join(notes, 'Releve bancaire mars.md'), '# Releve\nheldreleveemarker nothing real here\n');
await fs.writeFile(path.join(notes, 'Passport notes.txt'), 'heldpassportmarker nothing real here\n');
await textutilTo('docx', 'Contract draft.docx', 'heldcontractmarker nothing real here');
await textutilTo('rtf', 'Payslip October.rtf', 'heldpayslipmarker nothing real here');
const HELD_NAMES = ['Tax return 2023', 'Releve bancaire mars', 'Passport notes', 'Contract draft', 'Payslip October'];
const HELD_MARKERS = ['heldtaxmarker', 'heldreleveemarker', 'heldpassportmarker', 'heldcontractmarker', 'heldpayslipmarker'];

const server = startChatgpt({ home: env.home, script: path.join(stage, 'setup', 'mcp', 'server.mjs') });
const grep = needle => spawnSync('/usr/bin/grep', ['-rla', needle, env.dataHome], { encoding: 'utf8' }).stdout.trim();
const indexRows = async () => (await fs.readFile(path.join(env.dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '')).split('\n').filter(l => l && !l.startsWith('#'));
const privacyCalls = [];
const call = async (name, args) => { if (name === 'databrain_privacy') privacyCalls.push(args); return server.tool(name, args); };
try {
  await server.initialize();
  await call('databrain_setup_start', { folders: [notes] });                                  // shows the list, creates nothing
  await call('databrain_setup_start', { folders: [notes], confirmed: true });   // the user's yes; the setup reply is the job result shown in the status

  // ---- gate 1: no review step, indexing runs, held files absent, the rest present ----
  let sawPause = '';
  let last = '';
  await until(async () => {
    last = await call('databrain_setup_status');
    if (/SETUP PAUSED FOR PRIVACY REVIEW|paused for privacy review|complete the review/i.test(last)) sawPause = last;
    return /Stage: ready\./.test(last);
  }, 'setup reached ready with no review step', 120000);
  assert(!sawPause, `no status call may say setup is paused for the review:\n${sawPause}`);
  // ---- gate 4: the setup reply (the job result line in the status) ----
  const reply = last.split('\n').find(line => line.startsWith('destination selection:')) || '';
  assert(reply.includes('Created your DataBrain'), `the setup result line is in the status:\n${last}`);
  assert(reply.includes(PRIVATE), `the setup reply carries the private sentence:\n${reply}`);
  for (const name of [...HELD_NAMES, 'Tax return', 'Payslip', 'Passport', 'Contract', 'bancaire']) assert(!reply.includes(name), `the reply must not name a held file (${name}):\n${reply}`);
  assert(!/complete the review|paused|resume automatically|resumes automatically|once the user has reviewed/i.test(reply), `no pause wording in the reply:\n${reply}`);
  assert(/optional/i.test(reply) && /later/i.test(reply), `the reply says the review is optional and can wait:\n${reply}`);
  assert.equal(privacyCalls.length, 0, 'setup reached ready without any databrain_privacy call');
  const state = JSON.parse(await fs.readFile(env.statePath, 'utf8'));
  assert.notEqual(state.privacyPending, true, 'privacyPending is not set');
  const rows = (await indexRows()).join('\n');
  for (const ok of ['Garden.md', 'Reading list.txt', 'Trip plan.docx']) assert(rows.includes(ok), `${ok} must be indexed:\n${rows}`);
  for (const name of HELD_NAMES) assert(!rows.includes(name), `${name} must not be in the index`);
  for (const marker of ['okgardenmarker', 'okreadingmarker']) assert(grep(marker) !== '', `${marker} is searchable text`);
  const review = await fs.readFile(path.join(env.dataHome, 'Private files review.txt'), 'utf8');
  for (const name of HELD_NAMES) assert(review.includes(name), `${name} is listed in the review file`);
  assert.equal((review.match(/keep: no/g) || []).length >= 5, true, 'every held file starts on keep: no');
  const status = await call('databrain_setup_status');
  assert(status.includes(PRIVATE), `status says the private sentence:\n${status}`);

  // ---- gate 2: held files never opened, read or extracted ----
  const seen = await extractorSeen();
  assert(seen.has(await shaOf('Trip plan.docx')), `the extractor stub saw the harmless docx (the instrument works):\n${[...seen].join('\n')}`);
  for (const name of ['Contract draft.docx', 'Payslip October.rtf']) assert(!seen.has(await shaOf(name)), `an extractor was run on held file ${name}`);
  for (const marker of HELD_MARKERS) assert.equal(grep(marker), '', `${marker} text must never reach the DataBrain folder`);

  // ---- gate 3: release exactly one file ----
  const lines = review.split('\n');
  await fs.writeFile(path.join(env.dataHome, 'Private files review.txt'), lines.map(l => (l.includes('Contract draft.docx') ? l.replace('keep: no', 'keep: yes') : l)).join('\n'));
  const decided = await call('databrain_privacy', { action: 'decide' });   // "I reviewed my private files"
  assert(/^Recorded\. The files the user kept are indexed by the next refresh/.test(decided), decided);
  await call('databrain_refresh');
  await until(async () => (await indexRows()).join('\n').includes('Contract draft.docx'), 'the released file is indexed on the refresh', 240000);
  const after = (await indexRows()).join('\n');
  for (const name of HELD_NAMES.filter(n => n !== 'Contract draft')) assert(!after.includes(name), `${name} stays out after releasing another file`);
  await until(async () => grep('heldcontractmarker') !== '', 'the released file text is indexed', 240000);
  const seenAfter = await extractorSeen();
  assert(seenAfter.has(await shaOf('Contract draft.docx')), 'the released file is now extracted');
  assert(!seenAfter.has(await shaOf('Payslip October.rtf')), 'an extractor was run on Payslip October.rtf, which is still held');
  for (const marker of HELD_MARKERS.filter(m => m !== 'heldcontractmarker')) assert.equal(grep(marker), '', `${marker} must stay out`);
  console.log('PASS: ChatGPT first setup does not pause for the private-file review; held files are never read; one released file is indexed on the next refresh; the reply is the private sentence plus "optional, later".');
} finally {
  await server.stop();
  await fs.rm(stage, { recursive: true, force: true });
}
