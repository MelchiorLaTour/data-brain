import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverFile = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const hook = path.join(here, 'pause-open-preload.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-read-privacy-race-')));
const home = path.join(temp, 'home');
const source = path.join(temp, 'Documents');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(source, { recursive: true });
const realSource = await fs.realpath(source);
const note = path.join(realSource, 'ordinary.md');
const arm = path.join(temp, 'arm');
const signal = path.join(temp, 'signal');
const release = path.join(temp, 'release');
await fs.writeFile(note, '# Ordinary\nreadraceproofmarker harmless text.\n');

let serial = 0;
const server = spawn(process.execPath, ['--import', hook, serverFile, '--databrain-source-roots', realSource], {
  env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000',
    DATABRAIN_TEST_OPEN_PATH: note, DATABRAIN_TEST_OPEN_ARM: arm,
    DATABRAIN_TEST_OPEN_SIGNAL: signal, DATABRAIN_TEST_OPEN_RELEASE: release },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const pending = new Map();
let stderr = '';
server.stderr.setEncoding('utf8'); server.stderr.on('data', chunk => { stderr += chunk; });
readline.createInterface({ input: server.stdout }).on('line', line => {
  const message = JSON.parse(line); pending.get(message.id)?.(message);
});
function rpc(method, params = {}) {
  const id = ++serial;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), 60000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
const call = async (name, args = {}) => {
  const response = await rpc('tools/call', { name, arguments: args });
  return response.result?.content?.[0]?.text ?? JSON.stringify(response.error ?? response);
};
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, label) {
  for (let i = 0; i < 600; i++) { const value = await fn(); if (value) return value; await wait(100); }
  throw new Error(`timed out waiting for ${label}`);
}

try {
  await rpc('initialize', { protocolVersion: '2025-03-26' });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await call('databrain_setup_start');
  await until(async () => /Stage: (?:ready|verification pending)\./.test(await call('databrain_setup_status')), 'setup');
  const hits = await call('databrain_search', { query: 'readraceproofmarker' });
  const hitPath = hits.split('\n').find(line => /ordinary\.md$/.test(line.trim()))?.trim().split(/\s+/).at(-1);
  assert(hitPath, 'synthetic note did not appear in search');

  const benign = await call('databrain_read', { path: hitPath });
  assert.match(benign, /harmless text/, `ordinary read remains available:\n${benign}`);

  await fs.writeFile(arm, 'armed');
  const reading = call('databrain_read', { path: hitPath });
  await until(async () => !!await fs.stat(signal).catch(() => null), 'read open pause');
  await fs.writeFile(note, '# Ordinary\nreadraceproofmarker FR1420041010050500013M02606 SYNTHETIC_ONLY_CANARY_RACE\n');
  await fs.writeFile(release, 'go');
  const result = await reading;
  assert.doesNotMatch(result, /SYNTHETIC_ONLY_CANARY_RACE|FR1420041010050500013M02606/, `private current text must not escape:\n${result}`);
  assert.match(result, /holds it back|looks private|IBAN/i, `read explains that current text is held:\n${result}`);
  assert.equal(stderr.trim(), '', 'server produced no stderr');
  console.log('PASS: benign read works; same-inode private edit during the open race is held with no source text returned.');
} finally {
  server.kill('SIGKILL');
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
