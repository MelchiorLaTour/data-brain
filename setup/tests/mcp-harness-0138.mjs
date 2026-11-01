// Shared by the 0.1.38 tests: start the server in a fake HOME, call tools, wait for states. Invented data only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
export const here = path.dirname(fileURLToPath(import.meta.url));
export const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(200)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

export async function fakeHome(prefix) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `databrain-${prefix}-`)));
  const home = path.join(temp, 'home');
  const docs = path.join(home, 'Documents');
  await fs.mkdir(docs, { recursive: true });
  return { temp, home, docs: await fs.realpath(docs), dataHome: path.join(home, 'DataBrain'), statePath: path.join(home, 'DataBrain', '.databrain', 'desktop-state.json') };
}

export function startServer({ home, roots, env = {}, nodeArgs = [] }) {
  const child = spawn(process.execPath, [...nodeArgs, serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); return reply.result?.content?.[0]?.text ?? reply.error?.message ?? ''; };
  return { child, ask, tool };
}

export async function initialize(server) {
  await server.ask('initialize', { protocolVersion: '2025-03-26' });
  server.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
}

// Runs setup to "Stage: ready." and releases every held file ("keep nothing") so privacy review does not stop it.
export async function setupToReady(server, { decide = { keep: [] } } = {}) {
  await server.tool('databrain_setup_start');
  await until(async () => {
    const status = await server.tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', ...decide });
    return /Stage: ready\./.test(status);
  }, 'setup reached ready', 240000);
}
