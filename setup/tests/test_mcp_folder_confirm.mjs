// At first setup the user sees the exact folder list in the CHAT (no window) before anything is created or read.
// 1) The list uses plain names (Desktop, Documents, Downloads, Applications) and a full path only for any other folder.
// 2) The warning line and the cloud-download statement are in the text; nothing is created or read until setup_start is called again with confirmed true.
// 3) confirmed true without the list having been shown (or for another list) does nothing. After yes, setup goes on by itself and finishes.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-folder-confirm-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const home = path.join(temp, 'home');
const make = async (...parts) => { const dir = path.join(home, ...parts); await fs.mkdir(dir, { recursive: true }); return fs.realpath(dir); };
const desktop = await make('Desktop'), documents = await make('Documents'), downloads = await make('Downloads'), other = await make('Projects', 'Thesis');
const applications = path.join(temp, 'Applications'); await fs.mkdir(applications); const realApplications = await fs.realpath(applications);
await fs.writeFile(path.join(documents, 'plan.md'), '# Plan\nconfirmwindowmarker is in this note.\n');
const roots = [desktop, documents, downloads, realApplications, other];
const dataHome = path.join(home, 'DataBrain');
const exists = p => fs.access(p).then(() => true, () => false);

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_TEST_APP_DIRS: realApplications, DATABRAIN_TEST_CONSENT: 'ask', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
}

try {
  await session({}, async tool => {
    // confirmed true before any list was shown: the list is shown, nothing happens
    const early = await tool('databrain_setup_start', { confirmed: true });
    assert(/Nothing has been read or changed yet/.test(early), `early yes only shows the list: ${early}`);
    assert.equal(await exists(dataHome), false, 'no DataBrain folder after an early confirmed call');
    const reply = await tool('databrain_setup_start');
    for (const line of ['- Desktop', '- Documents', '- Downloads', '- Applications (your apps, like Notes)', `- ${other}`]) assert(reply.includes(line), `the list has "${line}": ${reply}`);
    assert(reply.includes('These come from your DataBrain settings. Some may be left over from an earlier install. Check each one before you say yes.'), `the exact warning line: ${reply}`);
    assert(/temporarily downloads any files that are only online in a cloud drive/.test(reply), `the cloud-download statement: ${reply}`);
    assert(/waiting for the user's yes/.test(reply) && /Nothing has been read or changed yet/.test(reply), `says nothing is read until yes: ${reply}`);
    assert.equal(await exists(dataHome), false, 'no DataBrain folder before the yes');
    assert.equal(await exists(path.join(home, 'DataBrain 2')), false, 'no second folder either');
    assert(!/Stage: (?:indexing|ready)/.test(await tool('databrain_setup_status')), 'nothing is indexing before the yes');
    // yes: setup finishes by itself
    const started = await tool('databrain_setup_start', { confirmed: true });
    assert(!/Nothing has been read or changed yet/.test(started), `the yes starts setup: ${started}`);
    await until(async () => {
      const status = await tool('databrain_setup_status');
      if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
      return /Stage: ready\./.test(status);
    }, 'setup reached ready after the yes');
    assert(/plan\.md/.test(await tool('databrain_search', { query: 'confirmwindowmarker' })), 'the note is searchable after the yes');
  });
  assert.equal(await exists(dataHome), true, 'the yes created the DataBrain folder');

  console.log('PASS: the folder list, the warning line and the cloud statement are shown in the chat before anything is created or read; an early or unmatched yes does nothing; the yes finishes setup.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
