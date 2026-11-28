// A DataBrain's own generated folders that sit INSIDE an approved source folder are never indexed or searched: moc/ (index, extracts, search
// database, room maps), app-content/ (generated Notes and Reminders mirrors) and .databrain/ (setup state, held file NAMES, app item records). Original notes next to it, and an ordinary folder that happens to be called "moc", are unaffected.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { scanSelectedFiles } from '../mcp/freshness-core.mjs';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-brain-folder-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); };
await write(path.join(docs, 'notes', 'real.md'), '# Real\nrealnotemarker an original note.\n');
await write(path.join(docs, 'oldbrain', 'own.md'), '# Own\nownnotemarker an original note in a folder that also holds a brain.\n');
await write(path.join(docs, 'oldbrain', 'moc', 'index.tsv'), 'generated\n');
await write(path.join(docs, 'oldbrain', 'moc', 'map.md'), '# Room map\ngeneratedmapmarker lives in a generated room map.\n');
await write(path.join(docs, 'oldbrain', 'moc', 'extracted', 'abc.txt'), 'generatedextractmarker lives in a generated extract.\n');
await write(path.join(docs, 'oldbrain', '.databrain', 'desktop-state.json'), '{"stage":"ready"}\n');
await write(path.join(docs, 'oldbrain', '.databrain', 'privacy.tsv'), 'held\t/Users/x/Payslip-heldnamemarker.pdf\treason\n');
await write(path.join(docs, 'oldbrain', '.databrain', 'held-names.txt'), 'heldnamestxtmarker is a text file inside the state folder.\n');
await write(path.join(docs, 'oldbrain', 'app-content', 'Notes', 'note-1.txt'), 'appmirrornotemarker is a generated mirror of a Notes item.\n');
await write(path.join(docs, 'oldbrain', 'app-content', 'Reminders', 'rem-1.txt'), 'appmirrorremindermarker is a generated mirror of a Reminders item.\n');
await write(path.join(docs, 'plainfolders', 'app-content', 'mine.md'), '# Mine\nordinaryappcontentmarker is in an ordinary folder called app-content.\n');
await write(path.join(docs, 'plainfolders', '.databrain', 'mine.md'), '# Mine\nordinarydotdatabrainmarker is in an ordinary folder called .databrain.\n');
await write(path.join(docs, 'ordinary', 'moc', 'plain.md'), '# Plain\nordinarymocmarker is in an ordinary folder called moc.\n');

// the freshness scan agrees with the engine
const realDocs = await fs.realpath(docs);
const scanned = (await scanSelectedFiles({ roots: [realDocs] })).map(file => path.relative(realDocs, file));
for (const generated of ['moc', 'app-content', '.databrain']) assert(!scanned.some(file => file.startsWith(path.join('oldbrain', generated))), `the freshness scan skips ${generated}: ${scanned}`);
assert(scanned.includes(path.join('oldbrain', 'own.md')) && scanned.includes(path.join('ordinary', 'moc', 'plain.md')) && scanned.includes(path.join('plainfolders', 'app-content', 'mine.md')) && scanned.includes(path.join('plainfolders', '.databrain', 'mine.md')), `originals and an ordinary moc folder are kept: ${scanned}`);

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realDocs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => {
    const status = await tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: ready\./.test(status);
  }, 'setup reached ready');
  for (const [marker, file] of [['realnotemarker', 'real.md'], ['ownnotemarker', 'own.md'], ['ordinarymocmarker', 'plain.md'], ['ordinaryappcontentmarker', 'mine.md'], ['ordinarydotdatabrainmarker', 'mine.md']]) assert(new RegExp(file.replace('.', '\\.')).test(await tool('databrain_search', { query: marker })), `${marker} is searchable`);
  for (const marker of ['generatedmapmarker', 'generatedextractmarker', 'heldnamestxtmarker', 'heldnamemarker', 'appmirrornotemarker', 'appmirrorremindermarker']) { const found = await tool('databrain_search', { query: marker }); assert(!/map\.md|abc\.txt|held-names|privacy\.tsv|note-1|rem-1|oldbrain\/(?:moc|app-content|\.databrain)/.test(found), `${marker} is never indexed or searched: ${found.slice(0, 400)}`); }
  const inventory = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8');
  assert(!/oldbrain\/(?:moc|app-content|\.databrain)/.test(inventory), 'no generated file is in the index');
  console.log('PASS: the generated folder of a brain inside an approved folder is never indexed or searched (engine walk and freshness scan); original notes next to it and an ordinary folder called moc are unaffected.');
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
