import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
process.env.DATABRAIN_TEST_NO_AUTO_LABELS = '1';   // this test walks the manual labelling steps; test_mcp_auto_labels.mjs covers the automatic finish

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-onboarding-'));

async function runCase(name, selected, precreate = false, sourceRoots = []) {
  const home = path.join(temp, name);
  const desktop = path.join(home, 'Desktop');
  const dataHome = path.join(desktop, 'DataBrain');
  const selectionFile = path.join(home, 'selection.txt');
  await fs.mkdir(desktop, { recursive: true });
  await fs.writeFile(selectionFile, selected);
  const selectedPath = selected.trim().startsWith('{') ? '' : selected.trim();
  if (selectedPath && selectedPath !== desktop) await fs.mkdir(selectedPath, { recursive: true });
  for (const root of sourceRoots) await fs.mkdir(root, { recursive: true });
  if (precreate) {
    await fs.mkdir(dataHome, { recursive: true });
    await fs.writeFile(path.join(dataHome, 'keep.txt'), 'existing user data');
  }

  const server = spawn(process.execPath, [serverScript], {
    env: {
      ...process.env,
      HOME: home,
      DATABRAIN_TEST_HOME: dataHome,
      DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      ...(sourceRoots.length ? { DATABRAIN_TEST_SOURCE_ROOTS: JSON.stringify(sourceRoots) } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  const lines = readline.createInterface({ input: server.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });

  try {
    await request('initialize', { protocolVersion: '2025-03-26' });
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const preSetupAudit = await request('tools/call', { name: 'databrain_verify_install', arguments: {} });
    const preSetupAuditText = preSetupAudit.result.content[0].text;
    assert(sourceRoots.length
      ? preSetupAuditText.includes('BLOCKED: Local setup audit')
      : preSetupAuditText.includes('BLOCKED: Local setup audit — Setup has not started.'), preSetupAuditText);
    if (!precreate) {
      await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'a pre-setup audit must not create the user DataBrain folder');
    }
    const start = await request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    const startText = start.result.content[0].text;
    if (precreate) {
      assert(startText.includes('already exists') && await fs.readFile(path.join(dataHome, 'keep.txt'), 'utf8') === 'existing user data');
      return;
    }
    assert(startText.includes('folder selection is open'));
    let status = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const reply = await request('tools/call', { name: 'databrain_setup_status', arguments: {} });
      status = reply.result.content[0].text;
      if (!status.includes('destination selection: running')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    if (selected.trim() === desktop) {
      assert(status.includes('Stage: destination ready'), status);
      const info = await fs.lstat(dataHome);
      assert(info.isDirectory() && (info.mode & 0o777) === 0o700, 'approved destination must be created with mode 0700');
      const state = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
      assert.deepEqual(state.roots, [], 'destination approval must not grant source access');
    } else if (selected.trim().startsWith('{')) {
      assert(status.includes('Stage: not configured'), status);
      assert(status.includes('destination selection: cancelled — Selection cancelled; no folder was created.'), status);
      await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'cancelling destination selection created the DataBrain folder');
      await assert.rejects(fs.lstat(path.join(dataHome, '.databrain', 'desktop-state.json')), { code: 'ENOENT' }, 'cancelling destination selection wrote setup state');
      await assert.rejects(fs.lstat(path.join(dataHome, '.source-roots')), { code: 'ENOENT' }, 'cancelling destination selection created a source grant');
    } else {
      assert(status.includes('destination selection: failed') && status.includes('Choose Desktop'), status);
      await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'wrong parent selection created the destination');
    }
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  }
}

// ChatGPT host: there is no destination chooser (the brain goes to ~/DataBrain and the folders are named in the chat), so the chooser cases below do not
// apply. What does apply is tested here: the pre-setup audit creates nothing, a start with no folders creates nothing, an existing folder is never taken over.
// Source: server.mjs lines 1944 (CHATGPT_NEED_FOLDERS) and 1936-1943 (beginDestinationSelection).
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
async function runChatgptCase(name, precreate) {
  const home = path.join(await fs.realpath(temp), name);   // a home that resolves through a symbolic link (/var on a Mac) is refused
  const dataHome = path.join(home, 'DataBrain');
  await fs.mkdir(home, { recursive: true });
  const notes = path.join(home, 'Notes'); await fs.mkdir(notes, { recursive: true });
  if (precreate) { await fs.mkdir(dataHome, { recursive: true }); await fs.writeFile(path.join(dataHome, 'keep.txt'), 'existing user data'); }
  const server = spawn(process.execPath, [serverScript, '--databrain-client', 'chatgpt'], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: server.stdout }).on('line', line => { const message = JSON.parse(line); replies.get(message.id)?.(message); });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 5000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  try {
    await request('initialize', { protocolVersion: '2025-03-26' });
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const audit = (await request('tools/call', { name: 'databrain_verify_install', arguments: {} })).result.content[0].text;
    assert(audit.includes('BLOCKED: Local setup audit — Setup has not started.'), audit);
    if (!precreate) await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'a pre-setup audit must not create the user DataBrain folder');
    const start = (await request('tools/call', { name: 'databrain_setup_start', arguments: precreate ? { folders: [await fs.realpath(notes)] } : {} })).result.content[0].text;
    if (precreate) {
      // ChatGPT never takes over a folder it did not create: the brain goes to "DataBrain 2" and the existing folder stays as it was (server.mjs chooseClaudeDataHome).
      assert(start.startsWith('Creating DataBrain in the home folder.'), start);
      assert.equal(await fs.readFile(path.join(dataHome, 'keep.txt'), 'utf8'), 'existing user data');
      assert.deepEqual(await fs.readdir(dataHome), ['keep.txt'], 'the existing folder must hold nothing of DataBrain');
      for (let i = 0; i < 300; i += 1) { if (await fs.lstat(path.join(home, 'DataBrain 2')).then(() => true, () => false)) break; await new Promise(resolve => setTimeout(resolve, 50)); }
            await fs.lstat(path.join(home, 'DataBrain 2'));
    } else {
      assert(start.startsWith('SETUP NOT STARTED. No folders are chosen yet.') && start.includes('Nothing has been read or created.'), start);
      await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'a start with no folders created the DataBrain folder');
    }
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  }
}

try {
  if (chatgpt) {
    await runChatgptCase('chatgpt-fresh', false);
    await runChatgptCase('chatgpt-existing', true);
    console.log('PASS: ChatGPT: the pre-setup audit reports incomplete state without creating DataBrain; a start with no folders asks for them and creates nothing; an existing DataBrain folder is never taken over: the brain goes to DataBrain 2. (The destination-chooser cases are not applicable on ChatGPT.)');
  } else {
  const cancelledHome = path.join(temp, 'cancelled');
  const cancelledSource = path.join(cancelledHome, 'Documents');
  await runCase('cancelled', JSON.stringify({ cancelled: true, paths: [] }), false, [cancelledSource]);
  const validHome = path.join(temp, 'approved');
  await runCase('approved', `${path.join(validHome, 'Desktop')}\n`);
  const wrongHome = path.join(temp, 'wrong');
  await runCase('wrong', `${path.join(wrongHome, 'Documents')}\n`);
  const existingHome = path.join(temp, 'existing');
  await runCase('existing', `${path.join(existingHome, 'Desktop')}\n`, true);
  }
  if (!chatgpt) console.log('PASS: pre-setup audit reports incomplete state without creating DataBrain; chooser cancellation records a cancelled job without creating DataBrain, setup state, or source grants; first-run approval creates only Desktop/DataBrain, rejects a different folder, and leaves an existing destination untouched.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
