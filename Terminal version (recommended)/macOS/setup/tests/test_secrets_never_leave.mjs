// Part 16b (0.2.1): no password or secret may appear in ANY tool result, in either host. Fake HOME, invented data. Every fixture carries a unique
// marker as the secret value (ZZSECRET...). Routes: md, txt, pdf, docx, rtf, doc, a Reminder (title and body), a Note body, a note captured through
// the chat, and an indexed note edited after it was indexed. Cases: every secret kind the privacy screen must hold, English and French.
// After a full setup, EVERY tool is called with queries built to find the fixtures (label words, file names, folder names, direct reads by path),
// and no marker may appear in the raw JSON of any result. A held file's name and path may not appear either, in the privacy review too (part 18: the review shows
// numbers; the names live in a local file, "Private files review.txt", that the model is not given and databrain_read refuses). Pages: no tool here can write a real Pages document, so the fixture is rich text saved with the .pages extension (the engine picks its reader by extension, and textutil by content); a real Pages file is NOT covered. Apple Notes: a stand-in app whose dictionary has a note class; the secret is in the BODY (plain, HTML-wrapped, and in a password-protected note).
// Print a table: route x case -> held / LEAKED. Run with DATABRAIN_TEST_CLIENT=claude first, then chatgpt.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-secrets-')));
const home = path.join(temp, 'home'); await fs.mkdir(home, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 300000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const docs = path.join(temp, 'Documents'); await fs.mkdir(docs, { recursive: true });
const appsDir = path.join(temp, 'Applications'); await fs.mkdir(appsDir, { recursive: true });
const realDocs = await fs.realpath(docs); const realApps = await fs.realpath(appsDir);

// ---- the cases: [id, text with the marker as the secret value, marker] ----
const CASES = [
  ['password-line', 'password: ZZSECRET-0001', 'ZZSECRET-0001'],
  ['password-sentence', 'the wifi password is ZZSECRET-0002', 'ZZSECRET-0002'],
  ['pw-label', 'pw: ZZSECRET-0003', 'ZZSECRET-0003'],
  ['passphrase', 'passphrase: ZZSECRET-0004 correct horse battery', 'ZZSECRET-0004'],
  ['api-key', 'api_key=ZZSECRET-0005abcdef', 'ZZSECRET-0005'],
  ['aws-key', 'key AKIAZZSECRET0006ABCD', 'AKIAZZSECRET0006ABCD'],
  ['github-token', 'ghp_ZZSECRET0007abcdefghijklmnopqrstuvwx', 'ZZSECRET0007'],
  ['seed-phrase', 'seed phrase: zzsecret abandon ability able about above absent absorb abstract absurd abuse access accident', 'zzsecret abandon'],
  ['ssn', 'SSN: 987-65-4321', '987-65-4321'],
  ['passport', 'passport number: 12ZZ34567', '12ZZ34567'],
  ['routing', 'routing number 021000021', '021000021'],
  ['security-answer', 'security question: first pet. answer: ZZSECRET-0008', 'ZZSECRET-0008'],
  ['backup-codes', 'backup codes: 55501234 55505678 55509012', '55501234'],
  ['login-pair', 'username: demo\npassword: ZZSECRET-0009', 'ZZSECRET-0009'],
  ['mdp-fr', 'mot de passe : ZZSECRET-0010', 'ZZSECRET-0010'],
];
const fixtures = [];   // { route, id, file, marker, later }
const add = (route, id, file, marker, later = false) => fixtures.push({ route, id, file, marker, later, name: path.basename(file) });
let phase = 1;   // 2 = after the refresh that holds the files changed after setup
const bodyFor = (id, text) => `# Kitchen plan ${id}\nkitchenmarker${id.replace(/\W/g, '')} an ordinary planning note.\n\n${text}\n\nSee you Friday.\n`;
for (const [id, text, marker] of CASES) {
  const file = path.join(realDocs, `heldfile-md-${id}-zq.md`); await fs.writeFile(file, bodyFor(id, text)); add('md', id, file, marker);
}
// the other formats carry the plain password line; txt directly, the rest converted from text with the tools macOS ships
const plain = (tag, marker) => `Kitchen plan ${tag}\nkitchenmarker${tag} an ordinary planning note.\n\npassword: ${marker}\n\nSee you Friday.\n`;
for (const [route, ext] of [['txt', 'txt'], ['pdf', 'pdf'], ['docx', 'docx'], ['rtf', 'rtf'], ['doc', 'doc'], ['pages', 'pages']]) {
  const tag = `${route}fmt`; const marker = `ZZSECRET-F${route.toUpperCase()}Z`;   // the closing Z keeps one marker from being the start of another (FDOC is the start of FDOCX: part 18 D)
  const source = path.join(temp, `source-${route}.txt`); await fs.writeFile(source, plain(tag, marker));
  const file = path.join(realDocs, `heldfile-${route}-zq.${ext}`);
  if (route === 'txt') await fs.copyFile(source, file);
  else if (route === 'pdf') { const r = spawnSync('/usr/sbin/cupsfilter', ['-m', 'application/pdf', source], { encoding: 'buffer' }); assert(r.status === 0 && r.stdout.length > 100, 'cupsfilter made a PDF'); await fs.writeFile(file, r.stdout); }
  else { const target = ext === 'pages' ? 'rtf' : ext; const r = spawnSync('/usr/bin/textutil', ['-convert', target, source, '-output', file]); assert.equal(r.status, 0, `textutil made ${target}`); }
  add(route, 'password-line', file, marker);
}
// formats the engine never indexes (csv, json, html, eml, code ...): they can only be reached by databrain_read with a path inside an approved folder
for (const [route, ext, wrap] of [['csv', 'csv', m => `site,password\nexample,${m}\n`], ['json', 'json', m => `{"note":"x","password":"${m}"}\n`], ['html', 'html', m => `<p>password: ${m}</p>\n`], ['eml', 'eml', m => `Subject: hi\n\npassword: ${m}\n`], ['py', 'py', m => `password = "${m}"\n`]]) {
  const marker = `ZZSECRET-X${route.toUpperCase()}`; const file = path.join(realDocs, `heldfile-${route}-zq.${ext}`); await fs.writeFile(file, wrap(marker)); add(route, 'password-line', file, marker);
}
// controls: ordinary text that mentions passwords and banks must stay searchable
await fs.writeFile(path.join(realDocs, 'control-prose.md'), '# Control\ncontrolmarkerprose I forgot my password again and had to reset it. I went to Chase to open an account today.\n');
// an ordinary indexed note that is edited after it was indexed
const editedFile = path.join(realDocs, 'heldfile-edited-zq.md'); await fs.writeFile(editedFile, '# Edited later\nkitchenmarkeredited an ordinary note.\n');

// ---- app items: a stand-in Reminders with a secret in a title and in a body (title-only and with a note) ----
const noteSdef = '<dictionary><suite name="S"><class name="note" code="cNte" plural="notes"><property name="name" code="pnam" type="text"/><property name="body" code="body" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="list"/><property name="password protected" code="pwlk" type="boolean" access="r"/></class></suite></dictionary>';
const sdef = '<dictionary><suite name="S"><class name="reminder" code="remd" plural="reminders"><property name="name" code="pnam" type="text"/><property name="body" code="body" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="list"/><property name="completed" code="comp" type="boolean"/></class></suite></dictionary>';
const bundle = path.join(appsDir, 'Reminders.app', 'Contents');
await fs.mkdir(path.join(bundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(bundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Reminders</string><key>CFBundleIdentifier</key><string>com.example.remindersstandin</string><key>CFBundleExecutable</key><string>Reminders</string><key>OSAScriptingDefinition</key><string>R.sdef</string></dict></plist>');
await fs.writeFile(path.join(bundle, 'Resources', 'R.sdef'), sdef);
const notesBundle = path.join(appsDir, 'Notes.app', 'Contents');
await fs.mkdir(path.join(notesBundle, 'Resources'), { recursive: true });
await fs.writeFile(path.join(notesBundle, 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleName</key><string>Notes</string><key>CFBundleIdentifier</key><string>com.example.notesstandin</string><key>CFBundleExecutable</key><string>Notes</string><key>OSAScriptingDefinition</key><string>N.sdef</string></dict></plist>');
await fs.writeFile(path.join(notesBundle, 'Resources', 'N.sdef'), noteSdef);
const fixture = path.join(temp, 'fixture.json'); const calls = path.join(temp, 'calls.log');
const row = (i, t, b, c, p = false) => ({ i, t, b, d: '2026-01-01T10:00:00Z', c, a: c === 'Notes' ? 'Notes' : 'Reminders', x: false, p });
await fs.writeFile(fixture, JSON.stringify([
  row('r-title', 'password: ZZSECRET-R1', '', 'Reminders'),
  row('r-body', 'Shopping list kitchenmarkerremind', 'password: ZZSECRET-R2', 'Reminders'),
  row('r-ok', 'Buy bread controlmarkerremind', '', 'Reminders'),
  row('n-body', 'Dinner ideas kitchenmarkernote', 'password: ZZSECRET-N1', 'Notes'),
  row('n-html', 'Pantry list kitchenmarkernotehtml', '<div>Pantry</div><div>the wifi password is ZZSECRET-N2</div>', 'Notes'),
  row('n-locked', 'Locked diary kitchenmarkernotelocked', 'api_key=ZZSECRET-N3abcdef', 'Notes', true),
  row('n-ok', 'Gift ideas controlmarkernote', 'a book and a plant', 'Notes'),
]));
const stub = path.join(temp, 'interpreter-stub.mjs');
await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
const script = process.argv[5];
const app = (script.match(/Application\\("([^"]+)"\\)/) || [])[1] || '';
const rows = JSON.parse(fs.readFileSync(process.env.FIXTURE, 'utf8')).filter(r => app.includes('/' + r.a + '.app'));
if (script.includes('// dates only')) console.log(JSON.stringify({ ids: rows.map(r => r.i), d: rows.map(r => r.d) }));
else if (script.includes('// fetch by id')) { const ids = JSON.parse(script.match(/for \\(const id of (\\[.*?\\])\\)/)[1]); console.log(JSON.stringify(rows.filter(r => ids.includes(r.i)))); }
else if (script.includes('// full read')) console.log(JSON.stringify(rows));
else { console.error('unexpected script'); process.exit(4); }
`, { mode: 0o755 });
add('reminder-title', 'password-line', 'Reminders/password', 'ZZSECRET-R1');
add('reminder-body', 'password-line', 'Reminders/Shopping list', 'ZZSECRET-R2');
add('note-body', 'password-line', 'Notes/Dinner ideas', 'ZZSECRET-N1');
add('note-body-html', 'password-sentence', 'Notes/Pantry list', 'ZZSECRET-N2');
add('note-locked', 'api-key', 'Notes/Locked diary', 'ZZSECRET-N3');

// ---- the server ----
const dataHome = path.join(home, 'DataBrain');
const env = { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: appsDir, DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE: fixture, CALL_LOG: calls, DATABRAIN_TEST_PRIVACY_CONSENT: undefined };
delete env.DATABRAIN_TEST_PRIVACY_CONSENT;
const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realApps, realDocs])], { env, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.resume();
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const results = [];   // every raw JSON reply of every tool call: [label, JSON text]
const call = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); const raw = JSON.stringify(reply); results.push([`${name} ${JSON.stringify(args).slice(0, 60)}`, raw, name, phase]); return reply.result?.content?.[0]?.text ?? ''; };
let leaks = 0;
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const toolList = (await ask('tools/list', {})).result.tools.map(tool => tool.name);
  if (chatgpt) { await call('databrain_setup_start', { folders: [realDocs, realApps] }); await call('databrain_setup_start', { folders: [realDocs, realApps], confirmed: true }); }
  else await call('databrain_setup_start');
  await until(async () => {
    const status = await call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) { await call('databrain_privacy', { action: 'list' }); await call('databrain_privacy', { action: 'decide', keep: [] }); }   // nothing held is released
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready', 900000);
  await sleep(4000);

  // later changes: an indexed note gets a secret, a note with a secret is captured through the chat
  await fs.appendFile(editedFile, '\npassword: ZZSECRET-E1\n'); add('edited-after-index', 'password-line', editedFile, 'ZZSECRET-E1', true);
  const captured = await call('databrain_capture', { title: 'Captured secret', body: 'kitchenmarkercapture\npassword: ZZSECRET-C1', keywords: ['kitchen', 'capture'], folder: realDocs });
  add('captured-note', 'password-line', path.join(realDocs, 'Captured secret.md'), 'ZZSECRET-C1', true);
  await sleep(6000);

  // every tool, with queries built to find every fixture
  const queries = ['password', 'passwort', 'mot de passe', 'secret', 'key token', 'seed phrase', 'SSN social security', 'passport', 'routing number', 'security answer', 'backup codes', 'username', 'kitchen plan', 'kitchenmarker', 'heldfile', 'zq', 'Shopping list', 'Reminders', 'Dinner ideas', 'Pantry list', 'Locked diary', 'Notes', 'wifi', 'controlmarker', 'kitchenmarkernote', 'Captured secret', ...fixtures.map(f => f.name.replace(/\.[a-z]+$/, '')), ...fixtures.map(f => `kitchenmarker${f.id.replace(/\W/g, '')}`)];
  for (const query of queries) { await call('databrain_search', { query, limit: 50 }); await call('databrain_abstain_check', { queries: [query, `${query} notes`] }); }
  for (const f of fixtures) { if (path.isAbsolute(f.file)) { await call('databrain_read', { path: f.file }); await call('databrain_read', { path: f.file.replace(home, '~') }); } }
  for (const name of ['databrain_setup_status', 'databrain_health', 'databrain_verify_install', 'databrain_diagnostics', 'databrain_taxonomy_candidates', 'databrain_cloud_check', 'databrain_refresh', 'databrain_repair', 'databrain_note_folder']) if (toolList.includes(name)) await call(name, name === 'databrain_note_folder' ? { action: 'get' } : {});
  await call('databrain_privacy', { action: 'list' });
  // part 18: the review shows numbers, never names. A decide by name or by an unlisted number is refused (and the refusal must not echo a name); the local review file is not readable through DataBrain
  for (const f of fixtures.filter(f => path.isAbsolute(f.file) && !f.later).slice(0, 6)) await call('databrain_privacy', { action: 'decide', keep: [f.name, f.file] });
  await call('databrain_privacy', { action: 'decide', keep: ['9999'] });
  const reviewFile = path.join(dataHome, 'Private files review.txt');
  const reviewOnDisk = await fs.readFile(reviewFile, 'utf8');
  assert(fixtures.filter(f => path.isAbsolute(f.file) && !f.later).some(f => reviewOnDisk.includes(f.name)), 'the local review file carries the held names (that is where the user reads them)');
  await call('databrain_read', { path: reviewFile }); await call('databrain_read', { path: reviewFile.replace(home, '~') });
  // the refresh that screens the files changed after setup; from then on their names must be gone too
  await call('databrain_refresh');
  await sleep(2000);
  await until(async () => !/Running now:/.test(await call('databrain_setup_status')), 'the refresh ends', 300000);
  await sleep(2000);
  phase = 2;
  for (const query of ['password', 'kitchen plan', 'heldfile', 'Captured secret', 'edited later', 'kitchenmarkeredited', 'kitchenmarkercapture']) { await call('databrain_search', { query, limit: 50 }); await call('databrain_abstain_check', { queries: [query, `${query} notes`] }); }
  for (const f of fixtures.filter(f => f.later)) { await call('databrain_read', { path: f.file }); await call('databrain_read', { path: f.file.replace(home, '~') }); }
  await call('databrain_setup_status');

  // the table: marker absent from every result; a held file's name and path absent from every result except the privacy review
  const rows = []; const names = [...new Set(fixtures.map(f => f.name))];
  for (const f of fixtures) {
    const markerHits = results.filter(([, raw]) => raw.includes(f.marker)).map(([label]) => label);
    // the capture job's own line in the status ("note write: complete — Created and indexed the new capture: <path>") echoes the title the model itself gave
    // in its own capture call, so it is not counted for the captured note
    const strip = raw => f.route === 'captured-note' ? raw.replace(/(?:Saved to: |new capture: |Created and indexed the new capture: )[^\\"]*Captured secret\.md/g, '') : raw;   // the path the model's own capture call was told, and the job line that repeats it
    const nameHits = results.filter(([, raw, tool, at]) => (!f.later || at === 2) && path.isAbsolute(f.file) && (strip(raw).includes(f.name) || strip(raw).includes(f.file.replace(home, '~')))).map(([label]) => label);
    const leaked = markerHits.length || nameHits.length;
    if (leaked && process.env.SECRETS_DEBUG) { const needle = markerHits.length ? f.marker : f.name; const raw = results.find(([label, text]) => label === (markerHits[0] || nameHits[0]) && text.includes(needle))?.[1] || ''; const at = raw.indexOf(needle); console.log(`  [debug] ${f.route}: ...${raw.slice(Math.max(0, at - 160), at + 80).replace(/\\n/g, ' | ')}...`); }
    if (leaked) leaks++;
    rows.push(`${f.route.padEnd(20)} ${f.id.padEnd(18)} ${leaked ? `LEAKED (${markerHits.length ? 'secret in ' + markerHits[0] : 'name/path in ' + nameHits[0]})` : 'held'}`);
  }
  // Part 22 (Mel): about held files the chat gets ONE sentence. No count, reason, source folder or number of held files in any result of any tool.
  const COUNTY = [/\bHeld back for privacy\b/, /\d+ file\(s\)[^"]*(?:waiting|held|private|excluded)/i, /waiting for the user/i, /source folder:/i, /\blooks like a bank statement\b/i, /\b(?:name|folder) (?:"[^"]*" )?looks private\b/i, /contains an? (?:IBAN|card number|private key|French social security number|password)/i, /\\n\d+\. [^\\]*keep: (?:no|yes)/i];
  const countLeaks = results.filter(([, raw]) => COUNTY.some(pattern => pattern.test(raw))).map(([label, raw]) => `${label}: ${raw.slice(0, 160)}`);
  assert.deepEqual(countLeaks, [], `a count, reason, folder or number of held files reached the chat:\n${countLeaks.join('\n')}`);
  assert(results.some(([, raw]) => raw.includes('Those files are private and cannot be accessed for privacy reasons.')), 'the one private sentence is what the chat gets');
  // controls stay searchable
  const control = await call('databrain_search', { query: 'controlmarkerprose' });
  const controlOk = /control-prose/.test(control);
  const reminderControl = /Buy bread/.test(await call('databrain_search', { query: 'controlmarkerremind' }));
  const noteControl = /Gift ideas/.test(await call('databrain_search', { query: 'controlmarkernote' }));
  console.log(`${chatgpt ? 'ChatGPT' : 'Claude'} host: route x case -> held / LEAKED (${fixtures.length} fixtures, ${results.length} tool calls)`);
  console.log(rows.join('\n'));
  console.log(`controls searchable: prose note ${controlOk ? 'yes' : 'NO'}, ordinary reminder ${reminderControl ? 'yes' : 'NO'}, ordinary note ${noteControl ? 'yes' : 'NO'}`);
  assert.equal(leaks, 0, `${leaks} fixture(s) LEAKED (see the table)`);
  assert(controlOk && reminderControl && noteControl, 'the controls (ordinary prose, an ordinary reminder, an ordinary note) must stay searchable');
  console.log(`PASS: no secret, held file name or held path appears in any of ${results.length} tool results (${chatgpt ? 'ChatGPT' : 'Claude'} host)`);
} finally {
  child.kill('SIGKILL'); await sleep(500);
  await fs.rm(temp, { recursive: true, force: true });
}
