// 0.2.1 part 2: under the ChatGPT host, a client that shows forms (MCP elicitation) gets a checkbox folder picker. The user's Accept is the
// consent; the model cannot give it. Decline, cancel, a timeout, an empty choice, a value that was never offered and a missing "other"
// folder all change nothing. A client without forms keeps the part-1 chat list. A missing or unreadable folder is named and never
// sends the user to repair. Real consent mode (DATABRAIN_TEST_CONSENT=ask). Invented data, fake HOME. Never ticks Applications.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

const { temp, home, dataHome, statePath } = await fakeHome('chatgpt-picker');
await writeNotes(path.join(home, 'Desktop'), { 'Plan.md': '# Garden plan\nTrellis code 7-Q-41. pickermarker\n' });
await writeNotes(path.join(home, 'Documents'), { 'Trip.md': '# Trip to Brettamoor\nThursday 08:12 platform 6. pickermarker\n' });
await writeNotes(path.join(home, 'Downloads'), { 'Receipt.md': '# Receipt\nInvented receipt for a kettle. pickermarker\n' });
await writeNotes(path.join(home, 'Extra'), { 'More.md': '# More\nInvented extra note. pickermarker\n' });
await fs.mkdir(path.join(home, 'Locked', 'Inner'), { recursive: true });
const exists = async p => fs.lstat(p).then(() => true, () => false);
const env = { DATABRAIN_TEST_CONSENT: 'ask' };
const forms = { elicitation: { form: {}, url: {} } };
const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const APPS = 'Applications (the apps you write in, like Notes)';
const nothingCreated = async label => assert(!(await exists(dataHome)), `${label}: nothing may be created`);

let server;
const ready = label => until(async () => {
  const status = await server.tool('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
  return /Stage: ready\./.test(status);
}, label, 240000);
server = startChatgpt({ home, env });
try {
  await server.initialize(forms);

  // 1. the tool list teaches the picker: no folders argument, no naming folders
  const tools = (await server.ask('tools/list', {})).result.tools;
  const start = tools.find(tool => tool.name === 'databrain_setup_start');
  assert(!('folders' in start.inputSchema.properties), 'the picker tool takes no folder list');
  assert(/checkbox picker/i.test(start.description) && /never name/i.test(start.description), start.description);
  assert(/not a repair problem/i.test(start.description), 'the description must keep the model off repair for a missing folder');
  for (const name of ['databrain_select_sources', 'databrain_add_sources']) {
    assert(!('folders' in tools.find(tool => tool.name === name).inputSchema.properties), name);
  }

  // the status before setup says the same thing as the descriptions: no asking the user for folder names
  const before = await server.tool('databrain_setup_status');
  assert(/with no arguments: the user chooses the folders in a picker/.test(before) && !/Ask the user which folders/.test(before), before);

  // 2. decline: nothing is created, nothing is read, and the form that was shown is the right one. The model's own list is ignored.
  let seenBeforeAnswer = null;
  server.answerWith(async params => { seenBeforeAnswer = { dataHome: await exists(dataHome) }; return { action: 'decline' }; });
  const declined = await server.tool('databrain_setup_start', { folders: [path.join(home, 'Extra')], confirmed: true });
  assert(/declined/i.test(declined) && /Nothing was read, created or changed/.test(declined), declined);
  assert.equal(seenBeforeAnswer.dataHome, false, 'nothing is created while the picker is open');
  await nothingCreated('decline');
  assert.equal(server.elicitations.length, 1);
  const form = server.elicitations[0];
  assert.equal(form.mode, 'form');
  const { folders, other } = form.requestedSchema.properties;
  assert.deepEqual(folders.items.enum, ['Desktop', 'Documents', 'Downloads', APPS], 'only folders that exist here are offered, in plain words');
  assert.deepEqual(folders.default, ['Desktop', 'Documents', 'Downloads'], 'Desktop, Documents and Downloads are ticked; Applications is not');
  assert.equal(folders.type, 'array');
  assert.equal(other.type, 'string');
  assert(!JSON.stringify(form).includes(home), 'the form never shows the home folder path');
  for (const piece of [/does NOT read/, /\.git/, /temporarily downloads any files that are only online/, /Your files stay on your Mac\. DataBrain has no cloud server and stores nothing of yours\. On ChatGPT, only the query and the snippets needed to answer it are sent to OpenAI's model\./, /Accept means yes/, /Decline or close/]) {
    assert(piece.test(form.message), `the picker text must say ${piece}: ${form.message}`);
  }
  assert(!/nothing leaves the machine/i.test(form.message));

  // 3. cancel, and no answer at all (timeout)
  server.answerWith(async () => ({ action: 'cancel' }));
  assert(/closed the folder picker/.test(await server.tool('databrain_setup_start')));
  await nothingCreated('cancel');
  await server.stop();
  server = startChatgpt({ home, env: { ...env, DATABRAIN_TEST_ELICIT_WAIT_MS: '400' } });
  await server.initialize(forms);
  server.answerWith(() => new Promise(() => {}));
  assert(/closed the folder picker.*timed out/.test(await server.tool('databrain_setup_start')), 'a picker nobody answers ends by itself');
  await nothingCreated('timeout');
  await server.stop();
  server = startChatgpt({ home, env });
  await server.initialize(forms);

  // 4. accept with bad content: nothing is created
  const bad = async (label, content, expected) => {
    server.answerWith(async () => ({ action: 'accept', content }));
    const reply = await server.tool('databrain_setup_start');
    assert(expected.test(reply), `${label}: ${reply}`);
    assert(!/repair/i.test(reply), `${label} must not suggest repair: ${reply}`);
    assert(!reply.includes(home), `${label} must not show the home folder: ${reply}`);
    await nothingCreated(label);
  };
  await bad('a value that was never offered', { folders: ['Desktop', '/etc'] }, /not offered/);
  await bad('a path as a folder label', { folders: [path.join(home, 'Extra')] }, /not offered/);
  await bad('folders of the wrong type', { folders: 'Desktop' }, /not offered/);
  await bad('Applications offered under another name', { folders: ['Applications'] }, /not offered/);
  await bad('other is not text', { folders: ['Desktop'], other: 42 }, /not usable text/);
  await bad('a missing other folder', { folders: ['Desktop'], other: '~/Nope' }, /^DataBrain: ~\/Nope does not exist\. Check the folder name\./);
  await bad('a relative other folder', { folders: ['Desktop'], other: 'Extra' }, /is not a full path/);
  await bad('a file as other folder', { folders: ['Desktop'], other: '~/Extra/More.md' }, /is a file or a link, not a plain folder/);
  await fs.chmod(path.join(home, 'Locked'), 0);
  try {
    await bad('an unreadable other folder', { folders: ['Desktop'], other: '~/Locked/Inner' }, /^DataBrain: macOS does not let DataBrain read ~\/Locked\/Inner\..*Files and Folders/);
  } finally { await fs.chmod(path.join(home, 'Locked'), 0o755); }
  await bad('nothing ticked', { folders: [], other: '  \n ' }, /No folder was ticked/);
  await bad('no folders key at all', {}, /No folder was ticked/);

  // 5. accept with valid values: this click is the consent for exactly the ticked folders (and the typed one)
  server.answerWith(async () => ({ action: 'accept', content: { folders: ['Desktop', 'Documents'], other: '~/Extra' } }));
  const accepted = await server.tool('databrain_setup_start');
  assert(/Creating DataBrain/.test(accepted) && /accepted the folder picker/.test(accepted) && !accepted.includes(home), accepted);
  await until(async () => {
    const status = await server.tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: ready\./.test(status);
  }, 'ready after the picker', 240000);
  assert.deepEqual((await readState()).roots.sort(), ['Desktop', 'Documents', 'Extra'].map(name => path.join(home, name)).sort());
  assert(!(await readState()).roots.includes('/Applications'));
  assert(/Brettamoor|platform 6/.test(await server.tool('databrain_search', { query: 'trip to Brettamoor' })), 'a ticked folder is searchable');
  assert(!/Receipt\.md|Invented receipt/.test(await server.tool('databrain_search', { query: 'receipt for a kettle' })), 'an unticked folder (Downloads) is not read');

  // 6. add: already approved folders are not offered again; decline changes nothing; accept adds
  server.answerWith(async () => ({ action: 'decline' }));
  await server.tool('databrain_add_sources');
  const addForm = server.elicitations.at(-1);
  assert.deepEqual(addForm.requestedSchema.properties.folders.items.enum, ['Downloads', APPS]);
  assert.deepEqual(addForm.requestedSchema.properties.folders.default, []);
  assert.equal((await readState()).roots.length, 3, 'decline must not add');
  server.answerWith(async () => ({ action: 'accept', content: { folders: ['Downloads'] } }));
  const added = await server.tool('databrain_add_sources');
  assert(!/waiting for the user's yes/.test(added), added);
  await until(async () => (await readState()).roots.length === 4, 'download folder approved');
  await server.tool('databrain_setup_run');   // changing folders reads nothing until the run, as in the Claude host
  await ready('ready after add');
  assert.equal((await readState()).roots.length, 4);

  // 7. select (replace): the picker starts from the approved list, keeps typed folders in "other", and an empty tick changes nothing
  server.answerWith(async () => ({ action: 'accept', content: { folders: [] } }));
  assert(/No folder was ticked/.test(await server.tool('databrain_select_sources')));
  assert.equal((await readState()).roots.length, 4, 'an empty choice must not remove everything');
  const selectForm = () => server.elicitations.at(-1).requestedSchema.properties;
  assert.deepEqual(selectForm().folders.default, ['Desktop', 'Documents', 'Downloads']);
  assert.equal(selectForm().other.default, '~/Extra');
  server.answerWith(async () => ({ action: 'accept', content: { folders: ['Desktop'], other: '~/Extra' } }));
  await server.tool('databrain_select_sources');
  await until(async () => (await readState()).roots.length === 2, 'replaced list saved');
  await server.tool('databrain_setup_run');
  await ready('ready after select');
  assert.deepEqual((await readState()).roots.sort(), ['Desktop', 'Extra'].map(name => path.join(home, name)).sort());

  // 8. an approved folder that goes missing is named, and repair is not suggested (repair cannot create a folder). The picker still
  //    works, so the user can drop it from the list.
  await fs.rename(path.join(home, 'Extra'), path.join(home, 'Extra-moved'));
  const gone = await server.tool('databrain_setup_status');
  assert(/~\/Extra does not exist\. Check the folder name\./.test(gone), gone);
  assert(!/repair/i.test(gone) && !gone.includes(home), `a missing folder must not suggest repair: ${gone}`);
  const diagnostics = await server.tool('databrain_diagnostics');
  assert(/~\/Extra: the folder does not exist/.test(diagnostics), diagnostics);
  assert(!/DataBrain repair is available/.test(diagnostics), `diagnostics must not send a missing folder to repair: ${diagnostics}`);
  server.answerWith(async () => ({ action: 'accept', content: { folders: ['Desktop'] } }));
  assert(!/does not exist/.test(await server.tool('databrain_select_sources')), 'the picker can drop a vanished folder');
  await fs.rename(path.join(home, 'Extra-moved'), path.join(home, 'Extra'));
} finally { await server.stop(); }

// 9. a client without forms keeps the chat list from part 1; a client that only does URLs is the same
for (const [label, capabilities] of [['no capabilities', undefined], ['url only', { elicitation: { url: {} } }]]) {
  const second = await fakeHome(`chatgpt-picker-fallback-${label.replace(/\W+/g, '-')}`);
  const fallback = startChatgpt({ home: second.home, env });
  try {
    await fallback.initialize(capabilities);
    fallback.answerWith(async () => { throw new Error('a client without forms must never be asked'); });
    const tools = (await fallback.ask('tools/list', {})).result.tools;
    assert('folders' in tools.find(tool => tool.name === 'databrain_setup_start').inputSchema.properties, `${label}: the chat-list argument stays`);
    const reply = await fallback.tool('databrain_setup_start');
    assert(/ask the user which folders/i.test(reply), `${label}: ${reply}`);
    assert(/Ask the user which folders to read/.test(await fallback.tool('databrain_setup_status')), `${label}: the status keeps the chat-list wording`);
    assert.equal(fallback.elicitations.length, 0, `${label}: no form is sent`);
    assert(!(await exists(second.dataHome)));
  } finally { await fallback.stop(); }
}

console.log('PASS: ChatGPT folder picker: it lists only existing folders in plain words (Desktop, Documents, Downloads ticked, Applications not), shows what is not read and the privacy sentence, and only an Accept with valid values adopts folders. Decline, cancel, timeout, empty, never-offered values and bad other folders change nothing; a missing or unreadable folder is named without repair; add, select and a client without forms behave as designed.');
