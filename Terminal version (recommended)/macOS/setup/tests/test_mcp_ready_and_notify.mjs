// After the automatic finish DataBrain runs its own local checks (setup contract, known-hit search/read; never the GitHub release
// check) and moves to 'ready' with no tool call. Status then says plainly "DataBrain is ready" and nothing about pending checks.
// DataBrain shows NO macOS notification banners. Ready and stopped are said in the chat, by the setup status.
// `osascript` is replaced by a stub that records its arguments: it must never be called.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-ready-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const stub = path.join(temp, 'osascript-stub.sh');
await fs.writeFile(stub, '#!/bin/bash\nprintf \'%s\\n\' "$*" >> "$NOTIFY_LOG"\n', { mode: 0o755 });

async function scenario(name, env, run) {
  const home = path.join(temp, name);
  const docs = path.join(home, 'Notes');
  await fs.mkdir(docs, { recursive: true });
  const real = await fs.realpath(docs);
  await fs.writeFile(path.join(real, 'harvest-plan.md'), '# Harvest plan\nreadymarker tomatoes and peppers in June.\n');
  await fs.writeFile(path.join(real, 'trip-notes.md'), '# Trip notes\nreadymarker the train leaves at nine.\n');
  const log = path.join(home, 'notify.log');
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home, NOTIFY_LOG: log, DATABRAIN_TEST_OSASCRIPT: stub, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0; const calls = [];
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (toolName, args = {}) => { calls.push(toolName); return (await ask('tools/call', { name: toolName, arguments: args })).result?.content?.[0]?.text ?? ''; };
  const notifications = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const savedState = async () => JSON.parse(await fs.readFile(path.join(home, 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8'));
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await run({ tool, calls, notifications, savedState, home, real });
  } finally { child.kill('SIGKILL'); }
}

try {
  // 1) a fresh brain reaches 'ready' with zero tool calls after setup start; no notification; plain status
  await scenario('ready', {}, async ({ tool, calls, notifications, savedState }) => {
    await tool('databrain_setup_start');
    await until(async () => (await savedState().catch(() => ({}))).stage === 'ready', "the saved stage reaches 'ready' with no tool call", 240000);
    assert.deepEqual(calls, ['databrain_setup_start'], 'no tool call other than setup start was needed');
    await sleep(1500);
    assert.deepEqual(await notifications(), [], 'no notification banner is sent when DataBrain is ready');
    const status = await tool('databrain_setup_status');
    assert(/Stage: ready\./.test(status) && /DataBrain is ready\./.test(status), `status says plainly that DataBrain is ready:\n${status.slice(0, 900)}`);
    assert(!/pending|still need|recall check|verification/i.test(status), `no word about pending checks at ready:\n${status.slice(0, 900)}`);
    const verify = await tool('databrain_verify_install');
    assert(/PASS: Setup contract/.test(verify) && /PASS: Known-hit search\/read/.test(verify), 'the same local checks pass in verify_install');
  });

  // 2) a first-run job that keeps failing: the status says it stopped; no notification
  await scenario('failed', { DATABRAIN_TEST_FAIL_JOB: 'initial indexing', DATABRAIN_TEST_RETRY_BASE_MS: '50' }, async ({ tool, notifications }) => {
    await tool('databrain_setup_start');
    await until(async () => /stopped after/i.test(await tool('databrain_setup_status')), 'the status says DataBrain stopped');
    await sleep(1500);
    assert.deepEqual(await notifications(), [], 'no notification banner is sent when DataBrain stops');
    assert(!/DataBrain is ready\./.test(await tool('databrain_setup_status')), 'not ready after a failure');
  });
  console.log("PASS: a fresh brain reaches 'ready' with no tool call after setup start, the status says ready or stopped in the chat, and no macOS notification banner is ever sent.");
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
