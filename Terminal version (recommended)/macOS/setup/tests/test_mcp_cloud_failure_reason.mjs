// A cloud download that fails leaves a short reason (not contents) that databrain_diagnostics shows. The failure is a file that cannot be read (chmod 000).
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloud-')));
const home = path.join(temp, 'home');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const grepAll = (needle, dir) => spawnSync('/usr/bin/grep', ['-rlaF', needle, dir], { encoding: 'utf8' }).stdout.trim();

const drive = path.join(home, 'Library', 'CloudStorage', 'OneDrive-Test', 'Docs');
await fs.mkdir(drive, { recursive: true });
const dir = await fs.realpath(drive);
const good = path.join(dir, 'good.md'); const bad = path.join(dir, 'bad.md'); const local = path.join(dir, 'local.md');
await fs.writeFile(good, '# G\ngoodmarker text.\n'.repeat(30));
await fs.writeFile(bad, '# B\nbadmarker text.\n'.repeat(30));
await fs.writeFile(local, '# L\nlocal file.\n');
const roots = [path.dirname(dir)];
const simulated = path.join(temp, 'dataless.txt');
await fs.writeFile(simulated, `${good}\n${bad}\n`);
await fs.writeFile(path.join(temp, 'brctl'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
const dataHome = path.join(home, 'DataBrain');

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, NB_TEST_DATALESS_LIST: simulated, NB_BRCTL: path.join(temp, 'brctl'), DATABRAIN_TEST_NO_AUTO_CLOUD: '1', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool, ask); }
  finally { child.kill('SIGTERM'); }
}

try {
  await session({ DATABRAIN_TEST_FREE_KB: '100000000' }, async tool => {
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), 'setup finished');
    await until(async () => { const status = await tool('databrain_setup_status'); return /Stage: (?:verification pending|ready)\./.test(status) && !/: running — /.test(status); }, 'settled');
    assert(!/Cloud download failures/.test(await tool('databrain_diagnostics')), 'no failure line before any fetch');
    await fs.chmod(bad, 0o000);
    const started = await tool('databrain_cloud_fetch'); assert(/Downloading 2 online-only files/.test(started), started);
    await until(async () => /Cloud download failures \(last fetch, top reasons\): 1 EACCES\./.test(await tool('databrain_diagnostics')), 'failure reason in diagnostics');
    const diag = await tool('databrain_diagnostics');
    assert(!diag.includes('badmarker') && !diag.includes('bad.md'), 'diagnostics must show reasons only, no file names or contents');
    await fs.chmod(bad, 0o644);
  });
  console.log('PASS: a failed cloud download leaves a short reason that databrain_diagnostics shows (counts by reason, no names or contents).');
} finally {
  await fs.chmod(bad, 0o644).catch(() => {});
  await sleep(2000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
