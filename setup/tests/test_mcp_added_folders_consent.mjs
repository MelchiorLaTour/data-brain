// A folder added in the extension settings AFTER setup is never read automatically: the chat shows the full folder list with the warning line
// and the cloud statement, and the folder is read only after the user's yes (databrain_add_sources with confirmed true, then setup_run).
// A folder removed in settings is dropped by itself. Search keeps working on the old folders while the new one waits.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-added-consent-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const home = path.join(temp, 'home');
const first = await fs.realpath(await fs.mkdir(path.join(home, 'Documents'), { recursive: true }).then(() => path.join(home, 'Documents')));
const second = await fs.realpath(await fs.mkdir(path.join(home, 'Projects', 'Thesis'), { recursive: true }).then(() => path.join(home, 'Projects', 'Thesis')));
await fs.writeFile(path.join(first, 'old.md'), '# Old\noldfoldermarker is in the first folder.\n');
await fs.writeFile(path.join(second, 'new.md'), '# New\naddedfoldermarker is in the folder added later.\n');
const statePath = path.join(home, 'DataBrain', '.databrain', 'desktop-state.json');
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));

async function session(roots, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_TEST_CONSENT: 'ask' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); return reply.result?.content?.[0]?.text ?? reply.error?.message ?? ''; };
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); await new Promise(resolve => { child.once('exit', resolve); setTimeout(resolve, 5000); }); }
}
const settle = async tool => until(async () => {
  const status = await tool('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await tool('databrain_privacy', { action: 'decide', keep: [] });
  return /Stage: ready\./.test(status);
}, 'ready');

try {
  // setup with one folder (list shown, then yes)
  await session([first], async tool => {
    assert(/waiting for the user's yes/.test(await tool('databrain_setup_start')), 'the list comes first');
    await tool('databrain_setup_start', { confirmed: true });
    await settle(tool);
    assert(/old\.md/.test(await tool('databrain_search', { query: 'oldfoldermarker' })));
  });
  assert.deepEqual((await state()).roots, [first]);

  // settings now hold two folders: the new one waits for the yes
  await session([first, second], async tool => {
    const status = await tool('databrain_setup_status');
    assert(/waiting for the user's yes and have not been read/.test(status), `status says the new folder waits: ${status.slice(0, 700)}`);
    assert(/old\.md/.test(await tool('databrain_search', { query: 'oldfoldermarker' })), 'search still works on the first folder (no settings-mismatch error)');
    await sleep(6000);
    assert.deepEqual((await state()).roots, [first], 'the new folder is not granted automatically');
    assert(!/new\.md/.test(await tool('databrain_search', { query: 'addedfoldermarker' })), 'the new folder is not searchable before the yes');
    // the chat shows the whole list with the warning and the cloud statement, and changes nothing
    const listed = await tool('databrain_add_sources');
    assert(listed.includes('- Documents') && listed.includes(`- ${second}`), listed);
    assert(listed.includes('These come from your DataBrain settings. Some may be left over from an earlier install. Check each one before you say yes.'), listed);
    assert(/temporarily downloads any files that are only online in a cloud drive/.test(listed), listed);
    assert.deepEqual((await state()).roots, [first], 'the list alone changes nothing');
    // yes: granted, then read by setup_run
    await tool('databrain_add_sources', { confirmed: true });
    await until(async () => ((await state()).roots || []).length === 2, 'the second folder is granted after the yes');
    await tool('databrain_setup_run');
    await settle(tool);
    assert(/new\.md/.test(await tool('databrain_search', { query: 'addedfoldermarker' })), 'the new folder is searchable after the yes');
  });

  // a folder removed in settings is dropped without any question
  await session([first], async tool => {
    await until(async () => ((await state()).roots || []).length === 1, 'the removed folder is dropped by itself');
    assert(!/new\.md/.test(await tool('databrain_search', { query: 'addedfoldermarker' })), 'the removed folder is no longer searchable');
  });
  console.log('PASS: a folder added in settings after setup waits for the user\'s yes in the chat (list + warning + cloud statement), is never read automatically, and is read after the yes; search keeps working meanwhile; a removed folder is dropped by itself.');
} finally {
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
