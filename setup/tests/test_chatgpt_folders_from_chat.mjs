// 0.2.1: under the ChatGPT host the user names the folders in the chat. The list is shown first and takes effect only after the user's yes
// for that exact list; it is saved in the brain's own state and survives a restart; adding needs a yes, removing does not; bad paths are
// refused with nothing created; the model cannot approve for the user. Real consent mode (DATABRAIN_TEST_CONSENT=ask). Invented data, fake HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

const { temp, home, dataHome, statePath } = await fakeHome('chatgpt-folders');
const garden = path.join(home, 'Garden');
const trips = path.join(home, 'Trips');
const bank = path.join(home, 'Taxes');
await writeNotes(garden, { 'Plan.md': '# Garden plan\nTrellis code 7-Q-41. chatfoldersmarker\n' });
await writeNotes(trips, { 'Brettamoor.md': '# Trip to Brettamoor\nThursday 08:12 platform 6. chatfoldersmarker\n' });
await writeNotes(bank, { 'Receipts.md': '# Receipts\nInvented receipts. chatfoldersmarker\n' });
await writeNotes(path.join(home, 'Extra'), { 'More.md': '# More\nInvented. chatfoldersmarker\n' });
await fs.writeFile(path.join(home, 'afile.md'), 'a file, not a folder\n');
await fs.symlink(garden, path.join(home, 'GardenLink'));
const tilde = folder => folder.replace(home, '~');   // results show the home folder as ~
const exists = async p => fs.lstat(p).then(() => true, () => false);
const env = { DATABRAIN_TEST_CONSENT: 'ask' };
const readState = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const ready = async server => until(async () => {
  const status = await server.tool('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
  return /Stage: ready\./.test(status);
}, 'ready', 240000);

let server = startChatgpt({ home, env });
try {
  await server.initialize();

  // 1. no folders: asks the model to ask the user, creates nothing
  const none = await server.tool('databrain_setup_start');
  assert(/ask the user which folders/i.test(none) && /Nothing has been read or created/.test(none), none);
  assert(!(await exists(dataHome)), 'no folders must create nothing');

  // 2. a list is shown with the warning and cloud lines; nothing created, nothing saved
  const shown = await server.tool('databrain_setup_start', { folders: [garden, '~/Trips'] });
  assert(/waiting for the user's yes/.test(shown) && shown.includes(tilde(garden)) && shown.includes(tilde(trips)) && !shown.includes(home), shown);
  assert(/Check each one before you say yes/.test(shown) && /temporarily downloads any files that are only online/.test(shown), shown);
  assert(!(await exists(dataHome)), 'a list nobody said yes to must create nothing');
  assert(/Selected source folders: 0\./.test(await server.tool('databrain_setup_status')), 'status must not treat the shown list as approved');

  // 3. a yes for a DIFFERENT list is not a yes for this one: it asks again
  const other = await server.tool('databrain_setup_start', { folders: [garden], confirmed: true });
  assert(/waiting for the user's yes/.test(other), `a different list needs its own yes: ${other}`);
  assert(!(await exists(dataHome)));
  // confirmed with no earlier showing in this process is not a yes either
  await server.stop();
  server = startChatgpt({ home, env });
  await server.initialize();
  const blind = await server.tool('databrain_setup_start', { folders: [garden, trips], confirmed: true });
  assert(/waiting for the user's yes/.test(blind), `confirmed true without a shown list must ask first: ${blind}`);
  assert(!(await exists(dataHome)));

  // 4. refused paths: relative, file, missing, symlink, root, 51 entries, wrong types. Nothing is created.
  for (const [label, folders] of [['relative', ['Garden']], ['a file', [path.join(home, 'afile.md')]], ['missing', [path.join(home, 'Nope')]], ['symlink', [path.join(home, 'GardenLink')]], ['root', ['/']], ['empty', []], ['not a list', 'Garden'], ['51 entries', Array.from({ length: 51 }, (_, i) => path.join(home, `f${i}`))], ['not strings', [42]]]) {
    const reply = await server.tool('databrain_setup_start', { folders, confirmed: true });
    assert(!/waiting for the user's yes/.test(reply) && !/Creating DataBrain/.test(reply), `${label} must be refused: ${reply}`);
    assert(!(await exists(dataHome)), `${label} created a folder`);
  }

  // 5. the same list shown, then yes: DataBrain is created and indexes; the approved list is saved in the brain's own state
  await server.tool('databrain_setup_start', { folders: [garden, trips] });
  const started = await server.tool('databrain_setup_start', { folders: [garden, trips], confirmed: true });
  assert(/Creating DataBrain/.test(started), started);
  await ready(server);
  const saved = await readState();
  assert.deepEqual([...saved.roots].sort(), [garden, trips].sort(), 'the approved list is saved in desktop-state.json');
  assert(/Garden plan/.test(await server.tool('databrain_search', { query: 'trellis code' })));
  assert(/Brettamoor/.test(await server.tool('databrain_search', { query: 'Brettamoor platform' })));
  // a second "set up" is not a new setup
  assert(/already started/.test(await server.tool('databrain_setup_start', { folders: [bank] })), 'setup start after setup does not take a new list');

  // 6. a restart keeps the list: the new process asks for no folders and does not ask for a yes again
  await server.stop();
  server = startChatgpt({ home, env });
  await server.initialize();
  const status = await server.tool('databrain_setup_status');
  assert(/Stage: ready\./.test(status) && /Selected source folders: 2\./.test(status), status);
  assert(!/waiting for the user's yes/.test(status), status);
  assert(/Garden plan/.test(await server.tool('databrain_search', { query: 'trellis code' })), 'search after restart');

  // 7. adding a folder: shown, nothing changes until the yes; a different list's yes does not count
  const addShown = await server.tool('databrain_add_sources', { folders: [bank] });
  assert(/waiting for the user's yes/.test(addShown) && addShown.includes(tilde(bank)) && addShown.includes(tilde(garden)), addShown);
  assert.deepEqual([...(await readState()).roots].sort(), [garden, trips].sort(), 'adding must change nothing before the yes');
  assert(!/Receipts/.test(await server.tool('databrain_search', { query: 'invented receipts' })));
  const wrong = await server.tool('databrain_add_sources', { folders: [bank, path.join(home, 'Extra')], confirmed: true });
  assert(/waiting for the user's yes/.test(wrong), `a yes for another list must ask again: ${wrong}`);
  assert.deepEqual([...(await readState()).roots].sort(), [garden, trips].sort());
  await server.tool('databrain_add_sources', { folders: [bank] });   // the list shown last is the one a yes counts for
const added = await server.tool('databrain_add_sources', { folders: [bank], confirmed: true });
  assert(/Applying the folder list the user approved|Reconciliation job/.test(added), added);
  await until(async () => (await readState()).roots.includes(bank), 'bank folder approved');
  await server.tool('databrain_setup_run');
  await ready(server);
  assert.deepEqual([...(await readState()).roots].sort(), [bank, garden, trips].sort());

  // 8. removing a folder needs no yes and drops its search data
  const removed = await server.tool('databrain_select_sources', { folders: [garden, trips] });
  assert(!/waiting for the user's yes/.test(removed), `removing a folder needs no yes: ${removed}`);
  await until(async () => !(await readState()).roots.includes(bank), 'bank folder dropped');
  await server.tool('databrain_setup_run');
  await ready(server);
  assert(!/Receipts/.test(await server.tool('databrain_search', { query: 'invented receipts' })), 'a removed folder is no longer searchable');

  // 9. the folder tools take the user's list only: no list, no change
  const empty = await server.tool('databrain_select_sources');
  assert(/No folders were given/.test(empty), empty);
  assert.deepEqual([...(await readState()).roots].sort(), [garden, trips].sort());

  // 10. a folder that contains or sits inside the DataBrain folder is refused
  const inside = await server.tool('databrain_add_sources', { folders: [dataHome] });
  const insideYes = await server.tool('databrain_add_sources', { folders: [dataHome], confirmed: true });
  await new Promise(r => setTimeout(r, 1500));
  assert(!(await readState()).roots.includes(dataHome), `the brain folder must never become a source: ${inside} / ${insideYes}`);

  console.log('PASS: ChatGPT host folders: a named list is shown first and changes nothing until the user says yes to that exact list; bad paths are refused; the approved list is saved in the brain\'s own state and survives a restart; adding waits for a yes, removing does not; the brain folder is never a source.');
} finally {
  await server.stop();
}
await fs.rm(temp, { recursive: true, force: true });
