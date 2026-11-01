// 0.1.38. (1) Files lying in an Applications folder are NOT indexed: "Applications" means the apps' content (Notes, Reminders). Index and
// inventory agree, so health is not FAIL (0.1.37 indexed 36 .txt files from /Applications that the inventory walk never listed).
// (2) The folders offered for saving a note never include DataBrain's own app-content folder, an Applications folder, or the generated
// folders of another brain inside an approved folder. (3) "Ask me each time" and "save here" are recorded even while indexing runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, initialize, setupToReady, sleep, startServer, until } from './mcp-harness-0138.mjs';

const { temp, home, docs, dataHome, statePath } = await fakeHome('apps-choices');
const apps = path.join(temp, 'Applications'); await fs.mkdir(path.join(apps, 'Pokemon Uranium 1.2.5'), { recursive: true });
const realApps = await fs.realpath(apps);
await fs.writeFile(path.join(realApps, 'Pokemon Uranium 1.2.5', 'readme.txt'), 'applicationsfilemarker a text file lying in an Applications folder.\n');
await fs.writeFile(path.join(realApps, 'loose.txt'), 'applicationsfilemarker loose file.\n');
const stub = path.join(temp, 'osascript-stub.sh'); await fs.writeFile(stub, '#!/bin/bash\necho "[]"\n', { mode: 0o755 });
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\nchoicesmarker invented note.\n');
const inbox = path.join(docs, 'inbox'); await fs.mkdir(inbox);
// another brain inside an approved folder: its generated folders must not be offered
const other = path.join(docs, 'Old Brain'); 
await fs.mkdir(path.join(other, '.databrain'), { recursive: true }); await fs.writeFile(path.join(other, '.databrain', 'desktop-state.json'), '{}');
await fs.mkdir(path.join(other, 'app-content'), { recursive: true });
const realOtherContent = await fs.realpath(path.join(other, 'app-content'));

const server = startServer({ home, roots: [realApps, docs], env: { DATABRAIN_TEST_APP_DIRS: realApps, DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_INDEX_DELAY_MS: '4000' } });
const { child, tool } = server;
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const note = title => ({ title, body: 'An invented note about tea.', keywords: ['tea', 'brewing'] });

try {
  await initialize(server);
  await server.tool('databrain_setup_start');
  // (3) while the first indexing runs, "ask me each time" is recorded at once
  await until(async () => { const s = await tool('databrain_setup_status'); if (process.env.DBG) console.log(s.slice(0, 300)); return /Stage: indexing\./.test(s); }, 'indexing started', 20000);
  const each = await tool('databrain_note_folder', { action: 'ask_each_time' });
  assert(/asks which folder to use every time/.test(each), `ask_each_time while indexing: ${each}`);
  await until(async () => {
    const status = await tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: ready\./.test(status);
  }, 'ready', 240000);
  assert.equal((await state()).noteFolderAsked, true, 'the choice survived the indexing job');
  assert.equal((await state()).noteDefaultFolder, undefined);

  // (1) files in the Applications folder are not indexed; health agrees
  const index = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  assert(!index.includes(realApps), `no file from the Applications folder is indexed:\n${index}`);
  assert(index.includes('plan.md'), 'the ordinary folder is indexed');
  const found = await tool('databrain_search', { query: 'applicationsfilemarker' });
  assert(!found.includes('loose.txt') && !found.includes('readme.txt'), `Applications files are not searchable: ${found}`);
  const health = await tool('databrain_health');
  assert(!/reported an issue/.test(health) && /File inventory: 1 indexed/.test(health), `health must not report a gap:\n${health}`);
  const verify = await tool('databrain_verify_install');
  assert(/PASS: Selected-source health/.test(verify), `the selected-source health check passes:\n${verify}`);

  // (2) the folders offered for saving
  const offered = await tool('databrain_capture', note('Offer'));
  assert(/No save folder was given/.test(offered), offered);
  const listed = offered.split('\n').filter(line => line.startsWith('- ')).map(line => line.slice(2));
  assert.deepEqual(listed, [docs], `only the document folder is offered, got ${listed}`);
  assert(!offered.includes('app-content') && !offered.includes(realApps), offered);
  for (const folder of [realOtherContent, path.join(dataHome, 'app-content'), realApps]) {
    await tool('databrain_capture', { ...note('Refused'), folder });
    await sleep(1200);
    assert.deepEqual((await fs.readdir(folder).catch(() => [])).filter(name => name.includes('Refused')), [], `nothing is saved in ${folder}`);
  }
  const refusedDefault = await tool('databrain_note_folder', { action: 'set', folder: realOtherContent });
  assert(!/without asking/.test(refusedDefault), `a brain's generated folder cannot be the default: ${refusedDefault}`);

  // a brain made by 0.1.37 still has the /Applications rows: the next refresh drops them
  const planRow = index.split('\n').find(line => line.includes('plan.md'));
  const oldRow = planRow.replace(/^[^\t]+/, path.join(realApps, 'loose.txt'));
  await fs.writeFile(path.join(dataHome, 'moc', 'index.tsv'), `${index.trimEnd()}\n${oldRow}\n`);
  assert(/reported an issue/.test(await tool('databrain_health')), 'with a leftover Applications row, health reports the gap (precondition)');

  // (3) "save here" is also recorded while a refresh runs
  await fs.writeFile(path.join(docs, 'more.md'), '# More\nchoicesmarker later file.\n');
  await tool('databrain_refresh');
  await until(async () => /Stage: indexing\.|update is running|refresh/i.test(await tool('databrain_setup_status')), 'refresh running');
  const set = await tool('databrain_note_folder', { action: 'set', folder: inbox });
  assert(set.includes(`New notes are saved in ${inbox} without asking.`), set);
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'refresh done');
  assert.equal((await state()).noteDefaultFolder, inbox, 'the default survived the refresh');
  assert(!(await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).includes(realApps), 'the refresh dropped the leftover Applications row');
  assert(!/reported an issue/.test(await tool('databrain_health')), 'health reports no gap after the refresh');
  console.log('PASS: Applications files are not indexed and health is not FAIL; save choices hide app-content, Applications and other brains; the save-folder choice is recorded while indexing');
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
