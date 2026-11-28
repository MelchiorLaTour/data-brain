// 0.2.1 part 2: the whole user journey in a fake HOME, once, checking each step on disk. Install from the REAL built zip (quarantined as a
// browser download), start the server exactly as config.toml says, set up through the folder picker (a scripted Accept), wait for ready,
// find a known fact, abstain on an absent one, save a note, verify (no FAIL), repair, install again and see the brain kept.
// Real consent mode. Invented data only; never touches the real home, ~/.codex or any real folder.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHome, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratchTgz = path.join(os.homedir(), 'Claude/databrain_public_release/scratch/node-official/dl/node.tgz');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-journey.'));
const build = spawnSync('bash', [path.join(root, 'setup/chatgpt/build.sh')], {
  env: { ...process.env, DATABRAIN_PACKAGING_OUT_DIR: path.join(work, 'out'), ...(process.env.DATABRAIN_NODE_TGZ || !existsSync(scratchTgz) ? {} : { DATABRAIN_NODE_TGZ: scratchTgz }) }, encoding: 'utf8',
});
assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
const zip = path.join(work, 'out/DataBrain-ChatGPT-Installer-0.2.1.zip');
execFileSync('xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, zip]);
await fs.mkdir(path.join(work, 'unpacked'));
execFileSync('ditto', ['-x', '-k', zip, path.join(work, 'unpacked')]);
const top = path.join(work, 'unpacked/DataBrain-ChatGPT-Installer-0.2.1');
execFileSync('xattr', ['-wr', 'com.apple.quarantine', '0083;6ae7cc02;Safari;', top]);

const { temp, home, dataHome, statePath } = await fakeHome('journey');
await writeNotes(path.join(home, 'Desktop'), { 'Garden.md': '# Garden plan\nTrellis code 7-Q-41 for the north fence. journeymarker\n' });
await writeNotes(path.join(home, 'Documents'), { 'Trip.md': '# Trip to Brettamoor\nThe train leaves Thursday 08:12 from platform 6. journeymarker\n' });
await writeNotes(path.join(home, 'Downloads'), { 'Kettle.md': '# Kettle manual\nDescale the kettle every month with citric acid. journeymarker\n' });
const env = { DATABRAIN_TEST_CONSENT: 'ask' };
const install = () => spawnSync(path.join(top, 'Install DataBrain for ChatGPT.command'), [], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: work }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
// the server as ChatGPT would start it: command and args taken from config.toml
const startFromConfig = () => {
  const config = readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
  const command = config.match(/^command = "(.*)"$/m)[1];
  const args = JSON.parse(config.match(/^args = (\[.*\])$/m)[1]);
  return startChatgpt({ home, env, script: args[0], node: command, extraArgs: args.slice(1) });
};
const ready = (server, label) => until(async () => {
  const status = await server.tool('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
  return /Stage: ready\./.test(status);
}, label, 240000);
const step = text => console.log(`  ok: ${text}`);

let server;
try {
  // 1. install
  const first = install();
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert(!existsSync(dataHome), 'installing creates no brain');
  step('installed from the quarantined zip; no brain created');

  // 2. the app starts the server from config.toml; the user says "Set up my DataBrain": one picker, one Accept
  server = startFromConfig();
  const init = await server.initialize({ elicitation: { form: {}, url: {} } });
  assert.equal(init.serverInfo.version, '0.2.1');
  assert(/Stage: not configured/.test(await server.tool('databrain_setup_status')));
  let pickerShownBeforeAnything = null;
  server.answerWith(async params => {
    pickerShownBeforeAnything = { brain: existsSync(dataHome), enumerated: params.requestedSchema.properties.folders.items.enum };
    return { action: 'accept', content: { folders: params.requestedSchema.properties.folders.default } };   // the user leaves the ticked defaults as they are
  });
  const started = await server.tool('databrain_setup_start');
  assert(/accepted the folder picker/.test(started), started);
  assert.equal(pickerShownBeforeAnything.brain, false, 'nothing exists while the picker is open');
  assert.equal(server.elicitations.length, 1, 'one picker, one Accept');
  await ready(server, 'ready');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.deepEqual([...state.roots].sort(), ['Desktop', 'Documents', 'Downloads'].map(name => path.join(home, name)).sort());
  assert(!state.roots.includes('/Applications'), 'Applications was offered but not ticked');
  step('picker Accept (the three default folders) -> ready; the approved list is saved in the brain');

  // 3. questions
  assert(/7-Q-41/.test(await server.tool('databrain_search', { query: 'trellis code north fence' })), 'a known fact is found');
  assert(/platform 6/.test(await server.tool('databrain_search', { query: 'train to Brettamoor' })));
  assert(/citric acid/.test(await server.tool('databrain_search', { query: 'descale the kettle' })), 'a Downloads file is found (it was ticked)');
  const absent = await server.tool('databrain_abstain_check', { queries: ['zzqxunmatched', 'zzqxabsent'] });
  assert(/DRY/.test(absent), `an absent fact abstains: ${absent}`);
  step('a known fact from each folder is found; an absent one abstains');

  // 4. save a note, then verify and repair
  const notes = path.join(home, 'Documents');
  const saved = await server.tool('databrain_capture', { title: 'Rope idea', body: 'An invented note about buying rope for the tent.', keywords: ['rope', 'tent'], folder: notes });
  assert(!/error|failed/i.test(saved), saved);
  await until(async () => (await server.tool('databrain_setup_status')).includes('note write: complete'), 'note saved', 120000);
  assert(/buying rope/.test(await server.tool('databrain_search', { query: 'rope for the tent' })), 'the saved note is found');
  // A saved note moves the stage back to 'relationships pending' for about 1.2 s while the report is rebuilt (measured the same on the part 12c and part 13 code); verify is asked once the brain says it is ready again.
  await until(async () => (await server.tool('databrain_setup_status')).includes('DataBrain is ready'), 'ready again after the note', 120000);
  const verify = await server.tool('databrain_verify_install');
  assert(!/^FAIL:/m.test(verify), `verify has no FAIL:\n${verify}`);
  assert(/(?:PASS|PARTIAL): Package identity — DataBrain for ChatGPT 0\.2\.1/.test(verify), verify);
  const repaired = await server.tool('databrain_repair');
  assert(!/error|failed/i.test(repaired.split('\n')[0]), repaired);
  assert(/Stage: ready\./.test(await server.tool('databrain_setup_status')));
  step('note saved and found; verify has no FAIL; repair finishes and the brain stays ready');
  await server.stop();

  // 5. install again (an update): the brain, its notes and its approved folders are all kept
  const brainBefore = readFileSync(statePath, 'utf8');
  const second = install();
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert(/already lists DataBrain/.test(second.stdout), second.stdout);
  assert.equal(readFileSync(statePath, 'utf8'), brainBefore, 'installing again does not touch the brain state');
  server = startFromConfig();
  await server.initialize({ elicitation: { form: {}, url: {} } });
  assert(/Stage: ready\./.test(await server.tool('databrain_setup_status')), 'the brain is ready after reinstall and restart');
  assert(/7-Q-41/.test(await server.tool('databrain_search', { query: 'trellis code north fence' })));
  assert(/buying rope/.test(await server.tool('databrain_search', { query: 'rope for the tent' })));
  assert.equal(server.elicitations.length, 0, 'no picker after reinstall: the choice is kept');
  step('installed again: brain, folders and the saved note are all kept; no picker is shown again');

  console.log('PASS: ChatGPT journey in a fake home: install from the quarantined built zip, start the server as config.toml says, set up through the picker with one Accept, ready, known facts found from each ticked folder, an absent one abstains, a note is saved and found, verify has no FAIL, repair keeps it ready, and installing again keeps the brain.');
} finally {
  if (server) await server.stop();
  await fs.rm(work, { recursive: true, force: true });
  await fs.rm(temp, { recursive: true, force: true });
}
