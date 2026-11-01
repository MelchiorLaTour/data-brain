// Saving a note: the folder is asked in the CHAT (no window). Without a folder and without a saved default the reply lists the approved
// folders and saves nothing. The first save asks once "Always save new notes here?"; databrain_note_folder stores the default (setup state)
// or goes back to "ask me each time", and says the mode in plain words. A folder outside the approved folders is refused.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-note-folder-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
const inbox = path.join(docs, 'inbox');
const elsewhere = path.join(temp, 'elsewhere');
await fs.mkdir(inbox, { recursive: true });
await fs.mkdir(elsewhere, { recursive: true });
const realDocs = await fs.realpath(docs), realInbox = await fs.realpath(inbox), realElsewhere = await fs.realpath(elsewhere);
await fs.writeFile(path.join(realDocs, 'plan.md'), '# Plan\nnotefoldermarker is in this note.\n');
const statePath = path.join(home, 'DataBrain', '.databrain', 'desktop-state.json');

const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', realDocs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
let n = 0;
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); return reply.result?.content?.[0]?.text ?? reply.error?.message ?? ''; };
const saved = async title => until(async () => (await tool('databrain_setup_status')).split('\n').some(line => line.includes('note write: complete') && line.includes(title)), `${title} saved`);
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const notes = async dir => (await fs.readdir(dir)).filter(name => name.endsWith('.md') && name !== 'plan.md');

try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => {
    const status = await tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: ready\./.test(status);
  }, 'setup reached ready');

  const note = (title, extra = {}) => ({ title, body: 'A short invented note about kombucha.', keywords: ['kombucha', 'brewing'], ...extra });

  // no folder, no default: the chat is asked, nothing is saved
  const asked = await tool('databrain_capture', note('First idea'));
  assert(/No save folder was given/.test(asked) && asked.includes(`- ${realDocs}`) && /Nothing was saved/.test(asked), asked);
  assert.deepEqual(await notes(realInbox), [], 'nothing saved without a folder');

  // a folder outside the approved folders is refused
  const refused = await tool('databrain_capture', note('Outside idea', { folder: realElsewhere }));
  await sleep(1500);
  assert.deepEqual(await notes(realElsewhere), [], 'nothing is written outside the approved folders');
  assert(!(await tool('databrain_setup_status')).includes('note write: complete — Created and indexed the new capture: ' + realElsewhere), `refused: ${refused}`);

  // with a folder: saved, and the one-time question is added to the reply of the job
  const second1 = await tool('databrain_capture', note('Second idea', { folder: realInbox }));
  assert(/Default save folder question: not asked yet/.test(second1), `the save reply says the default question was not asked yet: ${second1}`);
  await saved('Second idea');
  assert.equal((await notes(realInbox)).length, 1, 'the note was saved in the chosen folder');
  assert.equal((await state()).noteFolderAsked, true, 'the question is remembered as asked');
  assert.equal((await state()).noteDefaultFolder, undefined, 'no default without a yes');

  // the second save asks the folder again (no default) but does not repeat the default question
  assert(/No save folder was given/.test(await tool('databrain_file_note', note('Third idea', { themes: ['ideas'] }))), 'still asks for a folder');
  const third = await tool('databrain_file_note', note('Third idea', { themes: ['ideas'], folder: realInbox }));
  assert(!/Default save folder question/.test(third), 'the default question is not raised a second time');
  await saved('Third idea');

  // yes: the default is saved in the setup state and said in plain words
  const set = await tool('databrain_note_folder', { action: 'set', folder: realInbox });
  assert(set.includes(`New notes are saved in ${realInbox} without asking.`), set);
  assert.equal((await state()).noteDefaultFolder, realInbox);
  await tool('databrain_capture', note('Fourth idea'));
  await saved('Fourth idea');
  assert.equal((await notes(realInbox)).length, 3, 'the default folder was used without asking');

  // a default outside the approved folders is refused
  assert(!/without asking/.test(await tool('databrain_note_folder', { action: 'set', folder: realElsewhere })), 'a folder outside the approved folders cannot be the default');
  assert.equal((await state()).noteDefaultFolder, realInbox, 'the default is unchanged');

  // ask me each time: reversed, said in plain words
  const each = await tool('databrain_note_folder', { action: 'ask_each_time' });
  assert(/asks which folder to use every time/.test(each), each);
  assert.equal((await state()).noteDefaultFolder, undefined);
  assert(/No save folder was given/.test(await tool('databrain_capture', note('Fifth idea'))), 'asks again after ask_each_time');
  assert(/asks which folder to use every time/.test(await tool('databrain_note_folder', { action: 'show' })));

  console.log('PASS: the save folder is asked in the chat; the default question is asked once; "Always save new notes here" stores the default in the setup state and "ask me each time" reverses it, each said in plain words; folders outside the approved ones are refused.');
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
