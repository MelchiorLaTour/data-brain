// The Claude app quits (an update, a restart, an uninstall) while the database integrity check is running. (DataBrain opens no windows any more.) Nothing of that may stay behind. The window and the check are run by
// stand-in programs that hang, so the server is guaranteed to go away while they are busy. Processes are found by process group, not by
// name, so another run on this Mac cannot confuse the check. Three ways an extension stops: the app ends the process (SIGTERM), it closes the
// input (the server must not wait for the call in flight), or the server is killed with no chance to clean up (SIGKILL: a watcher inside the
// group ends the window or the check within about a second, as it does for the app reads and extract.sh). (The stand-ins start node by its full path: the server gives its children a bare PATH where `env node` finds nothing, and a
// stand-in that cannot start would make the test pass without proving anything.)
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const processes = () => spawnSync('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,command='], { encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  .map(line => { const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line); return m && { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), command: m[4] }; }).filter(Boolean);
async function until(check, label, limit = 90000) { for (const t0 = Date.now(); !(await check()); await sleep(100)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const ownGroup = processes().find(p => p.pid === process.pid)?.pgid;

function connect(env, home, root) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', root], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, ask, exited, ready };
}

async function scenario(kind, how) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-killc-')));
  const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
  const root = await fs.realpath(docs);
  await fs.writeFile(path.join(root, 'plain.md'), '# Plain\nkillcmarker an ordinary note.\n');
  const stub = path.join(temp, `hanging-${kind}.mjs`);
  await fs.writeFile(stub, `#!${process.execPath}\nsetTimeout(() => {}, 300000);\n`, { mode: 0o755 });
  const groupOf = () => processes().find(p => p.command.includes(stub))?.pgid ?? null;
  let server; let group = null;
  try {
    {
      // set up normally to ready, then ask for the health report with an integrity check that never ends
      const first = connect({}, home, root); await first.ready;
      await first.ask('tools/call', { name: 'databrain_setup_start', arguments: {} });
      await until(async () => {
        const status = (await first.ask('tools/call', { name: 'databrain_setup_status', arguments: {} })).result?.content?.[0]?.text ?? '';
        if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await first.ask('tools/call', { name: 'databrain_privacy', arguments: { action: 'decide', keep: [] } });
        return /Stage: ready\./.test(status);
      }, 'setup reaches ready', 120000);
      first.child.kill('SIGTERM'); await first.exited;
      server = connect({ DATABRAIN_TEST_QUICK_CHECK_BINARY: stub }, home, root); await server.ready;
      server.ask('tools/call', { name: 'databrain_health', arguments: {} });   // not awaited: it returns when the check ends
    }
    await until(() => { group = groupOf(); return group !== null; }, `${kind} (${how}): the ${kind === 'window' ? 'window' : 'check'} starts`);
    const serverGroup = processes().find(p => p.pid === server.child.pid)?.pgid;
    assert(group !== serverGroup && group !== ownGroup, `${kind} (${how}): it runs in its own process group, not the server's or the test's`);
    const t0 = Date.now();
    if (how === 'SIGTERM') server.child.kill('SIGTERM'); else if (how === 'SIGKILL') server.child.kill('SIGKILL'); else server.child.stdin.end();
    const leaveLimit = 8000;
    await Promise.race([server.exited, sleep(leaveLimit).then(() => { throw new Error(`${kind} (${how}): the server did not leave within ${leaveLimit / 1000} s`); })]);
    await until(() => processes().every(p => p.pgid !== group), `${kind} (${how}): its processes are gone`, how === 'SIGKILL' ? 10000 : 3000)
      .catch(() => { throw new Error(`${kind} (${how}): still running ${how === 'SIGKILL' ? 10 : 3} s after the server left:\n${processes().filter(p => p.pgid === group).map(p => `${p.pid} ${p.command}`).join('\n')}`); });
    return Date.now() - t0;
  } finally {
    server?.child.kill('SIGKILL');
    if (group && group !== ownGroup) { try { process.kill(-group, 'SIGKILL'); } catch {} }   // never the test's own group
    await sleep(300);
    await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
  }
}

const took = [];
for (const kind of ['check']) for (const how of ['SIGTERM', 'stdin closed', 'SIGKILL']) took.push(`${kind} ${how} ${await scenario(kind, how)} ms`);
console.log(`PASS: the server going away while the integrity check is running (${took.join(', ')}) leaves neither behind.`);
