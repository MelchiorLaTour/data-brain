// Private held-file release: the user naming the exact held files in the chat is the approval (there is no window). Nothing is released otherwise.
// All source content and homes in this test are invented and disposable.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-privacy-consent-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Documents');
const apps = path.join(temp, 'Applications');
const appBundle = path.join(apps, 'Fixture Notes.app');
const appContents = path.join(appBundle, 'Contents');
const appResources = path.join(appContents, 'Resources');
const appFixture = path.join(temp, 'app-items.json');
const appStub = path.join(temp, 'app-interpreter.mjs');
await fs.mkdir(docs, { recursive: true });
await fs.mkdir(appResources, { recursive: true });
await fs.writeFile(path.join(docs, 'payslip.md'), '# Pay slip\nprivate-marker-never-read-before-approval\n');
await fs.writeFile(path.join(docs, 'bank.md'), '# Bank\nsecond-private-marker\n');
await fs.writeFile(path.join(appContents, 'Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>test.fixture-notes</string><key>CFBundleName</key><string>Fixture Notes</string><key>OSAScriptingDefinition</key><string>Fixture.sdef</string></dict></plist>');
await fs.writeFile(path.join(appResources, 'Fixture.sdef'), '<dictionary><suite name="S"><class name="note" code="note" plural="notes"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/><property name="id" code="ID  " type="text" access="r"/><property name="modification date" code="modd" type="date"/></class></suite></dictionary>');
await fs.writeFile(appFixture, JSON.stringify([{ i: 'note-1', t: 'Payslip app item', b: 'private-app-marker-never-read-before-approval', d: '2026-10-01T10:00:00Z' }]));
await fs.writeFile(appStub, `#!/bin/bash
if [ "$3" != "-e" ] || [[ "$4" != *"// full read"* ]]; then echo 'unexpected app query' >&2; exit 2; fi
/bin/cat '${appFixture}'
`, { mode: 0o755 });

const launch = (consent, extraEnv = {}) => spawn(process.execPath, [serverScript, '--databrain-source-roots', docs, apps], {
  env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: apps, DATABRAIN_TEST_APP_OSASCRIPT: appStub, DATABRAIN_TEST_APP_TIMEOUT_MS: '5000', ...(consent === undefined ? {} : { DATABRAIN_TEST_PRIVACY_CONSENT: consent }), ...extraEnv },
  stdio: ['pipe', 'pipe', 'pipe'],
});
let server = launch(undefined);
const replies = new Map();
let serverError = '';
const attach = child => {
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', part => { serverError += part; });
  readline.createInterface({ input: child.stdout }).on('line', line => { const msg = JSON.parse(line); replies.get(msg.id)?.(msg); });
};
attach(server);
let id = 0;
const rpc = (method, params = {}) => new Promise((resolve, reject) => {
  const requestId = ++id;
  const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}\n${serverError}`)), 60000);
  replies.set(requestId, msg => { clearTimeout(timer); resolve(msg); });
  server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
});
const call = async (name, args = {}) => (await rpc('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(check, label) {
  for (let n = 0; n < 300; n++) { const value = await check(); if (value) return value; await pause(100); }
  throw new Error(`Timed out waiting for ${label}`);
}

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await call('databrain_setup_start');
  await waitFor(async () => (await call('databrain_setup_status')).includes('SETUP PAUSED FOR PRIVACY REVIEW'), 'privacy pause');
  const listed = await call('databrain_privacy', { action: 'list' });
  assert.match(listed, /payslip\.md/);
  assert.match(listed, /bank\.md/);
  const privacyFile = () => fs.readFile(path.join(home, 'DataBrain', '.databrain', 'privacy.tsv'), 'utf8');

  const forged = await call('databrain_privacy', { action: 'decide', keep: ['payslip.md', path.join(docs, 'invented.md')] });
  assert.doesNotMatch(forged, /Recorded:/, 'an invented additional path must block the batch');
  assert.match(await privacyFile(), /held\t.*payslip\.md/);
  assert.match(await privacyFile(), /held\t.*bank\.md/);
  await assert.rejects(fs.stat(path.join(home, 'DataBrain', 'moc', 'index.tsv')), { code: 'ENOENT' });
  assert.doesNotMatch(await call('databrain_read', { path: path.join(docs, 'payslip.md') }), /private-marker-never-read-before-approval/);

  const approved = await call('databrain_privacy', { action: 'decide', keep: ['payslip.md'] });
  assert.match(approved, /1 allowed/);
  assert.match(await privacyFile(), /allowed\t.*payslip\.md/);
  assert.match(await privacyFile(), /excluded\t.*bank\.md/);
  await waitFor(async () => /Payslip app item/.test(await call('databrain_privacy', { action: 'list' })), 'app item held after app scan');
  const appList = await call('databrain_privacy', { action: 'list' });
  const appShownLine = appList.split('\n').find(line => line.includes('Payslip app item'));
  const appShown = appShownLine.slice(2, appShownLine.lastIndexOf(' ('));
  const heldRows = (await privacyFile()).trim().split('\n').map(row => row.split('\t'));
  const appHeldPath = heldRows.find(([status, file]) => status === 'held' && file.includes('app-content'))?.[1];
  assert.ok(appHeldPath, 'the app item must be held by its logical mirror path');
  await assert.rejects(fs.stat(appHeldPath), { code: 'ENOENT' }, 'held app content must have been deleted before approval');
  const approvedApp = await call('databrain_privacy', { action: 'decide', keep: [appShown] });
  assert.match(approvedApp, /1 allowed/);
  await waitFor(async () => /Stage: (?:taxonomy pending|verification pending|ready)\./.test(await call('databrain_setup_status')), 'released app item indexing to settle');

  const activeMirrorFile = path.join(docs, 'payslip-next.md');
  await fs.writeFile(activeMirrorFile, '# Pay slip\nordinary active-mirror regression marker.\n');
  await fs.appendFile(path.join(home, 'DataBrain', '.databrain', 'privacy.tsv'), `held\t${activeMirrorFile}\tsynthetic fake-home held row\n`);
  const activeMirrorList = await call('databrain_privacy', { action: 'list' });
  assert.match(activeMirrorList, /payslip-next\.md/);
  const activeMirrorApproval = await call('databrain_privacy', { action: 'decide', keep: ['payslip-next.md'] });
  assert.match(activeMirrorApproval, /1 allowed/, 'active app mirror must not invalidate the selected user-root identity check');
  await waitFor(async () => /Stage: (?:taxonomy pending|verification pending|ready)\./.test(await call('databrain_setup_status')), 'ordinary active-mirror release to settle');
  console.log('PASS: held files stay held until the user names them; a forged extra path blocks the batch; naming releases a deleted held app item and ordinary files.');
} finally {
  // Stop the server, then wait until it and every engine process it started (their command lines name the temp brain) are gone, so nothing is still writing when the folder is deleted.
  // Anything still alive 10 s after the stop is a product signal and fails the test with its own message. fs.rm is not retried and its errors are not swallowed.
  const exited = server.exitCode !== null || server.signalCode !== null ? Promise.resolve() : new Promise(resolve => server.once('exit', resolve));
  server.kill();
  await exited;
  const stillAlive = () => spawnSync('/bin/ps', ['-axo', 'pid=,command=']).stdout.toString().split('\n').filter(line => line.includes(temp) && !line.trim().startsWith(`${process.pid} `));
  let alive = stillAlive();
  for (const t0 = Date.now(); alive.length && Date.now() - t0 < 10000; alive = stillAlive()) await new Promise(resolve => setTimeout(resolve, 200));
  if (alive.length) throw new Error(`DataBrain kept writing after it was stopped: ${alive.join(' | ')}`);
  await fs.rm(temp, { recursive: true, force: true });
}
