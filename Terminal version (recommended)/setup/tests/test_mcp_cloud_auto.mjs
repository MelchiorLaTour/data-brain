// Cloud-only files, like the terminal: the chat consent at setup names the temporary downloads, so once the first indexing ends the download and
// indexing of online-only files starts BY ITSELF (no dialog, no second question); iCloud files go back to online-only afterwards. Health never FAILs
// because of cloud-only files (they are counted as placeholders). A file with no indexed text is downloaded when it is read.
// The online-only state is SIMULATED (a list of paths).
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloud-auto-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 150000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

async function scenario(name, env, run) {
  const home = path.join(temp, name);
  const iCloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Notes');
  await fs.mkdir(iCloud, { recursive: true });
  const real = await fs.realpath(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs'));
  const online = path.join(real, 'Notes', 'online.md'), local = path.join(real, 'Notes', 'local.md');
  await fs.writeFile(online, '# Online\nautocloudmarker text that only exists online.\n'.repeat(20));
  await fs.writeFile(local, '# Local\nlocalautomarker an ordinary local file.\n');
  const simulated = path.join(temp, `${name}-dataless.txt`); await fs.writeFile(simulated, `${online}\n`);
  const evictLog = path.join(temp, `${name}-evict.log`);
  const brctl = path.join(temp, `${name}-brctl`); await fs.writeFile(brctl, `#!/bin/bash\necho "$@" >> "${evictLog}"\n`, { mode: 0o755 });
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home, NB_TEST_DATALESS_LIST: simulated, NB_BRCTL: brctl, DATABRAIN_TEST_FREE_KB: '100000000', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (toolName, args = {}) => (await ask('tools/call', { name: toolName, arguments: args })).result?.content?.[0]?.text ?? '';
  try {
    await ask('initialize', { protocolVersion: '2025-03-26' });
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await tool('databrain_setup_start');
    await run({ tool, home, simulated, evictLog, online });
  } finally { child.kill('SIGTERM'); }
}
const indexText = home => fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8').catch(() => '');

try {
  // 1) no second question: the online-only file is downloaded and indexed by itself, and iCloud files are re-offloaded
  await scenario('auto', {}, async ({ tool, home, simulated, evictLog }) => {
    await until(async () => (await indexText(home)).includes('online.md'), 'the online-only file is indexed without any tool call');
    await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), 'settled');
    assert.equal((await fs.readFile(simulated, 'utf8')).trim(), '', 'the file was downloaded');
    await until(async () => (await fs.readFile(evictLog, 'utf8').catch(() => '')).includes('online.md'), 'the iCloud file is made online-only again');
    assert(/online\.md/.test(await tool('databrain_search', { query: 'autocloudmarker' })), 'the downloaded file is searchable');
  });

  // 2) health never FAILs because of cloud-only files that are not yet downloaded
  await scenario('health', { DATABRAIN_TEST_NO_AUTO_CLOUD: '1' }, async ({ tool, home }) => {
    await until(async () => /Stage: (?:verification pending|ready)\./.test(await tool('databrain_setup_status')), 'setup finished');
    assert(!(await indexText(home)).includes('online.md'), 'not downloaded yet');
    const audit = await tool('databrain_verify_install');
    const line = audit.split('\n').find(row => row.includes('Selected-source health')) ?? '';
    assert(line && !/^FAIL/.test(line), `health is not FAIL for a cloud-only file: ${line || audit.slice(0, 600)}`);
    assert(/cloud placeholders 1/.test(line), `the cloud-only file is counted as a placeholder: ${line}`);
  });
  console.log('PASS: after setup the online-only files are downloaded and indexed by themselves (iCloud files go back online-only); health never FAILs for cloud-only files (counted as placeholders).');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
