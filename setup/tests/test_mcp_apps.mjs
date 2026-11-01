// Apps are read generically, by how they store data, never by name. Everything here uses STUB apps in temp "Applications" folders and a stub
// script interpreter: no real app is ever touched. The Applications folder in the settings means "the user's apps": DataBrain finds each app,
// reads scriptable ones through their dictionary only (an app's own data folders are never opened), never reads password
// managers (or Mail/Messages unless added on purpose), says plainly what it could not read, and puts every item through the privacy screen.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-apps-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const grepAll = (needle, dir) => spawnSync('/usr/bin/grep', ['-rlaF', needle, dir], { encoding: 'utf8' }).stdout.trim();

// ---- stub "Applications" folders: /Applications, /System/Applications and ~/Applications stand-ins ----
const appsMain = path.join(temp, 'Applications'); const appsSystem = path.join(temp, 'SystemApplications'); const appsUser = path.join(home, 'Applications');
for (const dir of [appsMain, appsSystem, appsUser]) await fs.mkdir(dir, { recursive: true });
const realMain = await fs.realpath(appsMain);
const plist = (id, name, sdef) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${id}</string><key>CFBundleName</key><string>${name}</string>${sdef ? `<key>OSAScriptingDefinition</key><string>${sdef}</string>` : ''}</dict></plist>`;
async function stubApp(dir, folderName, id, name, sdefName = null, sdefXml = null) {
  const bundle = path.join(dir, `${folderName}.app`);
  await fs.mkdir(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  await fs.writeFile(path.join(bundle, 'Contents', 'Info.plist'), plist(id, name, sdefName));
  if (sdefName) await fs.writeFile(path.join(bundle, 'Contents', 'Resources', sdefName), sdefXml);
  await fs.writeFile(path.join(bundle, 'Contents', 'Resources', 'README.md'), '# Readme inside an app bundle\nbundlemarker licence text that must never be indexed.\n');
  return bundle;
}
const sdefA = '<dictionary><suite name="S"><class name="memo" code="memo" plural="memos"><property name="name" code="pnam" type="text"/><property name="content" code="ctnt" type="text"/><property name="modification date" code="modd" type="date"/><property name="container" code="ctnr" type="folder"/><property name="password protected" code="pwpr" type="boolean"/></class><class name="folder" code="fold" plural="folders"><property name="name" code="pnam" type="text"/></class></suite></dictionary>';
const sdefB = '<dictionary><suite name="S"><class name="entry" code="entr" plural="entries"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/></class></suite></dictionary>';
await stubApp(appsMain, 'Scribbler', 'test.scribbler', 'Scribbler', 'Scribbler.sdef', sdefA);          // scriptable: memo / name / content
await stubApp(appsSystem, 'Journalist', 'test.journalist', 'Journalist', 'Journalist.sdef', sdefB);     // scriptable, other vocabulary: entry / title / text
await stubApp(appsMain, 'Binder', 'test.binder', 'Binder');                                           // no dictionary, keeps normal files in its data folder: never read
await stubApp(appsMain, 'Vault Keeper', 'test.vault', 'Vault Passwords');                             // password-manager-like: never read
await stubApp(appsSystem, 'Courier', 'com.apple.mail', 'Courier');                                    // Mail-like: not read from the whole folder
await stubApp(appsUser, 'Lonely', 'test.lonely', 'Lonely');                                           // no dictionary: nothing readable
await stubApp(appsMain, 'Guarded', 'test.guarded', 'Guarded', 'Guarded.sdef', sdefB);                 // scriptable, but macOS says no
// data folders of the stub apps (the same places real apps use)
const containerDocs = id => path.join(home, 'Library', 'Containers', id, 'Data', 'Documents');
await fs.mkdir(path.join(containerDocs('test.binder'), 'sub'), { recursive: true });
await fs.mkdir(path.join(containerDocs('test.binder'), 'Cache'), { recursive: true });
await fs.writeFile(path.join(containerDocs('test.binder'), 'plans.md'), '# Plans\nfilesmarker the binder keeps this plan as a normal file.\n');
await fs.writeFile(path.join(containerDocs('test.binder'), 'sub', 'ideas.txt'), 'filesmarkertwo an idea in a sub folder\n');
await fs.writeFile(path.join(containerDocs('test.binder'), 'Cache', 'junk.txt'), 'cachemarker temporary cache text\n');
await fs.mkdir(containerDocs('test.vault'), { recursive: true });
await fs.writeFile(path.join(containerDocs('test.vault'), 'logins.txt'), 'vaultmarker hunter2\n');
await fs.mkdir(containerDocs('com.apple.mail'), { recursive: true });
await fs.writeFile(path.join(containerDocs('com.apple.mail'), 'draft.txt'), 'mailmarker a private letter\n');

// ---- stub interpreter: checks the script DataBrain built from each dictionary, then answers like the app would ----
const fixtureA = path.join(temp, 'fixture-a.json'); const fixtureB = path.join(temp, 'fixture-b.json');
const memos = [
  { t: 'Garden plan', b: 'memomarker tomatoes need staking in June.', d: '2026-01-02T10:00:00Z', c: 'Home' },
  { t: 'Locked diary', b: 'lockedmemomarker secret thoughts', c: 'Home', p: true },
  { t: 'Old list', b: 'deletedmemomarker long gone', c: 'Recently Deleted' },
  { t: 'payslip march', b: 'privatememomarker my pay', c: 'Home' },
  { t: 'Formatted', b: '<div>htmlmarker <b>bold</b> text<br>second line</div>', c: 'Home' },
];
await fs.writeFile(fixtureA, JSON.stringify(memos));
await fs.writeFile(fixtureB, JSON.stringify([{ t: 'Trip log', b: 'entrymarker the ferry leaves at nine.' }]));
const stub = path.join(temp, 'interpreter-stub.sh');
await fs.writeFile(stub, `#!/bin/bash
script="$4"
case "$script" in
  *Guarded.app*) echo "execution error: Not authorized to send Apple events to Guarded. (-1743)" >&2; exit 1 ;;
  *Scribbler.app*) for needle in 'c = app.memos' 'c.name()' 'c.content()' 'c.modificationDate()' 'c.container().map(' 'c.passwordProtected()'; do case "$script" in *"$needle"*) ;; *) echo "missing $needle" >&2; exit 2 ;; esac; done; cat "$FIXTURE_A"; exit 0 ;;
  *Journalist.app*) for needle in 'c = app.entries' 'c.title()' 'c.text()'; do case "$script" in *"$needle"*) ;; *) echo "missing $needle" >&2; exit 2 ;; esac; done; cat "$FIXTURE_B"; exit 0 ;;
esac
echo "unexpected app script" >&2; exit 3
`, { mode: 0o755 });

const dataHome = path.join(home, 'DataBrain');
function start(roots, env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], {
    env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: [appsMain, appsSystem, appsUser].join(':'), DATABRAIN_TEST_APP_OSASCRIPT: stub, FIXTURE_A: fixtureA, FIXTURE_B: fixtureB, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  return { child, tool, ready };
}
const settled = text => /Stage: (?:verification pending|ready)\./.test(text);
const hitLines = text => text.split('\n').filter(line => /^\s*\d+\s+-?[0-9]+(?:\.[0-9]+)?\s+\S/.test(line));

const other = path.join(temp, 'Documents'); await fs.mkdir(other, { recursive: true });
const realOther = await fs.realpath(other);
await fs.writeFile(path.join(realOther, 'plain.md'), '# Plain\nplainmarker an ordinary note.\n');

let server = null;
try {
  server = start([realMain, realOther]);
  await server.ready;
  let first = await server.tool('databrain_setup_start');
  let last = '';
  await until(async () => { last = await server.tool('databrain_setup_status'); return settled(last); }, 'setup finished').catch(error => { throw new Error(`${error.message}\n${last.slice(0, 4000)}`); });
  const { tool } = server;

  // 1) scriptable apps through their dictionaries (two different vocabularies), found in all three application folders
  const memo = await tool('databrain_search', { query: 'memomarker', limit: 8 });
  assert(/From your files: Scribbler > Home > Garden plan/.test(memo), `a result shows "<App> > <container> > <title>":\n${memo}`);
  const entry = await tool('databrain_search', { query: 'entrymarker', limit: 8 });
  assert(/From your files: Journalist > Trip log/.test(entry), `the second dictionary (other class and property names) is read too:\n${entry}`);
  const memoPath = hitLines(memo)[0].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '');
  const read = await tool('databrain_read', { path: memoPath });
  assert(/memomarker tomatoes need staking/.test(read), `reading returns the item's text:\n${read}`);
  assert(/htmlmarker bold text/.test(await tool('databrain_read', { path: hitLines(await tool('databrain_search', { query: 'htmlmarker' }))[0].replace(/^\s*\d+\s+-?[0-9.]+\s+/, '') })), 'html bodies are turned into plain text');

  // 2) an app without a dictionary is not read, even when it keeps ordinary files in its data folder
  for (const marker of ['filesmarker', 'filesmarkertwo']) assert.equal(grepAll(marker, dataHome), '', `"${marker}" (files in an app data folder) must never be read`);
  assert(!/From your files: Binder/.test(await tool('databrain_search', { query: 'filesmarker' })), 'files in an app data folder are not indexed');

  // 3) never read / not read / skipped
  for (const marker of ['vaultmarker', 'mailmarker', 'lockedmemomarker', 'deletedmemomarker', 'bundlemarker', 'cachemarker', 'privatememomarker']) assert.equal(grepAll(marker, dataHome), '', `"${marker}" must never reach the DataBrain folder`);

  // 4) status: per app, counts only, plain sentences
  const status = await tool('databrain_setup_status');
  assert(/Apps: 7 found in the Applications folder; \d+ included\./.test(status), `apps found and included counted:\n${status}`);
  assert(/Included apps: .*Journalist \(1 item\)/.test(status) && /Scribbler \(2 items\)/.test(status), `included apps with item counts (the held item is not counted; Binder is not included):\n${status}`);
  assert(/Never read: Vault Passwords \(password managers, Keychain, Passwords and Wallet are never read/.test(status), `password manager refused with a reason:\n${status}`);
  assert(/Mail and Messages are not read in this version, to protect your private messages\./.test(status), `mail-like app: the plain sentence:\n${status}`);
  assert(!/individually/i.test(status), 'no "add them individually" wording');
  assert(/(?:Binder and Lonely|Lonely and Binder) have nothing DataBrain can read\./.test(status), `apps without a dictionary: one plain sentence:\n${status}`);
  assert(!/Binder \(\d+ items?\)/.test(status), 'Binder is not counted as included');
  assert(/Guarded could not be read: macOS did not allow DataBrain to control it\. To allow it, open System Settings > Privacy & Security > Automation/.test(status), `denied app says where to turn it on:\n${status}`);
  for (const title of ['Garden plan', 'Locked diary', 'Trip log', 'plans', 'ideas']) assert(!status.split('\n').filter(line => /^(?:Apps|Included apps|Never read|Found but not read)/.test(line)).join('\n').includes(title), `status must not name items ("${title}")`);

  // 5) privacy: the private-looking item is held by name and never indexed
  assert(/payslip march/.test(await tool('databrain_privacy', { action: 'list' })) || /Held back for privacy review/.test(status), 'the private-looking item is held for review');

  // 6) refresh picks up new, edited and deleted app items
  await fs.writeFile(fixtureA, JSON.stringify([...memos.filter(item => item.t !== 'Garden plan'), { t: 'New idea', b: 'freshmemomarker a brand new memo', c: 'Home' }]));
  await tool('databrain_refresh');
  await until(async () => (await tool('databrain_search', { query: 'freshmemomarker' })).includes('From your files: Scribbler > Home > New idea'), 'a new item is picked up by refresh');
  await until(async () => !(await tool('databrain_search', { query: 'memomarker' })).includes('Garden plan'), 'a deleted item disappears after refresh');

  await until(async () => { const text = await tool('databrain_setup_status'); return settled(text) && !/Running now/.test(text); }, 'the refresh finished');
  await sleep(1500);

  // 7) removing the Applications folder from the settings removes everything that came from the apps
  server.child.kill('SIGKILL');
  server = start([realOther]);
  await server.ready;
  let afterRemoval = '';
  await until(async () => { afterRemoval = await server.tool('databrain_setup_status'); return settled(afterRemoval) && !/Apps:/.test(afterRemoval); }, 'the change applied by itself').catch(error => { throw new Error(`${error.message}\n${afterRemoval.slice(0, 3000)}`); });
  assert((await server.tool('databrain_search', { query: 'plainmarker' })).includes('plain.md'), 'the ordinary folder is still indexed');
  for (const marker of ['filesmarker', 'entrymarker', 'freshmemomarker']) assert.equal(grepAll(marker, dataHome), '', `"${marker}" must be gone after the Applications folder was removed`);
  await assert.rejects(fs.stat(path.join(dataHome, 'app-content')), { code: 'ENOENT' }, 'the app-content folder is removed');

  // 8) no code path chooses a reader by app name
  const readers = await fs.readFile(path.join(here, '../mcp/app-readers.mjs'), 'utf8');
  const serverText = await fs.readFile(serverScript, 'utf8');
  assert(!/\b(?:Notes|Reminders|Calendar|Contacts|Mail|Messages|Safari|Pages|Numbers|Keynote|TextEdit|Obsidian|Notion|Bear|Evernote|Things|Slack|Music|Photos|Podcasts|Finder|Preview|Journal)\b/.test(readers), 'app-readers.mjs must not name any app');
  assert(!/com\.apple\./.test(readers) && !/com\.apple\./.test(serverText), 'no bundle id outside the policy file');
  assert(!/(?:bundleId|\.name)\s*(?:===|==|!==)\s*['"`]/.test(readers) && !/appName\s*===/.test(serverText), 'no equality test on an app name or id in the readers');
  console.log('PASS: apps are read generically: dictionaries (two vocabularies), never the data folders of an app, never password managers, Mail-like apps only when added on purpose, denied and nothing-to-read said plainly, counts only, privacy screen, refresh, removal, and no code path checks an app name.');
} finally {
  server?.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
