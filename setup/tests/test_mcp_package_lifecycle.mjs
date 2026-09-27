import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Same-version local package-replacement/uninstall simulation. This checks the
// boundary between disposable extension files and persistent user data; it is
// not a Claude Desktop update/uninstall acceptance test.
const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePackage = path.resolve(process.argv[2] || path.join(here, '../packaging/stage'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-package-lifecycle-')));
const packageA = path.join(temp, 'extension-A');
const packageB = path.join(temp, 'extension-B');
const home = path.join(temp, 'home');
const parent = path.join(temp, 'approved parent');
const source = path.join(temp, 'approved source');
const dataHome = path.join(parent, 'DataBrain');
const original = path.join(source, 'only-record.md');

async function digestFile(file) {
  return createHash('sha256').update(await fs.readFile(file)).digest('hex');
}

async function treeDigest(root) {
  const entries = [];
  async function visit(folder, relative = '') {
    for (const entry of (await fs.readdir(folder, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = path.join(folder, entry.name);
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(child, name);
      else if (entry.isFile()) entries.push(`${name}\0${await digestFile(child)}`);
      else entries.push(`${name}\0special:${entry.isSymbolicLink() ? await fs.readlink(child) : 'other'}`);
    }
  }
  await visit(root);
  return createHash('sha256').update(entries.join('\n')).digest('hex');
}

function startServer(extensionRoot) {
  const server = spawn(process.execPath, [
    path.join(extensionRoot, 'setup/mcp/server.mjs'),
    '--databrain-parent', parent,
    '--databrain-source-roots', source,
  ], {
    env: { ...process.env, HOME: home, DATABRAIN_ENGINE_DIR: extensionRoot },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  const stderr = [];
  const lines = readline.createInterface({ input: server.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', chunk => stderr.push(chunk));
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => {
      replies.delete(requestId);
      reject(new Error(`Timed out waiting for ${method}; stderr: ${stderr.join('')}`));
    }, 20000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  return { server, request, stderr };
}

async function initialize(client) {
  const reply = await client.request('initialize', { protocolVersion: '2025-03-26' });
  assert.equal(reply.error, undefined, JSON.stringify(reply));
  client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
}

async function call(client, name, args = {}) {
  const reply = await client.request('tools/call', { name, arguments: args });
  assert.equal(reply.error, undefined, `${name}: ${JSON.stringify(reply)}`);
  return reply.result.content[0].text;
}

async function waitForStage(client, expected) {
  let status = '';
  for (let attempt = 0; attempt < 400; attempt += 1) {
    status = await call(client, 'databrain_setup_status');
    if (status.includes(`Stage: ${expected}.`)) return status;
    if (status.includes('initial indexing: failed')) assert.fail(status);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for stage ${expected}: ${status}`);
}

async function stop(client) {
  if (client.server.exitCode !== null) return;
  const exited = new Promise(resolve => client.server.once('exit', resolve));
  client.server.kill('SIGTERM');
  await exited;
}

try {
  await fs.access(path.join(sourcePackage, 'setup/mcp/server.mjs'));
  const [manifestA, manifestB] = await Promise.all([
    fs.readFile(path.join(sourcePackage, 'manifest.json'), 'utf8'),
    fs.readFile(path.join(sourcePackage, 'manifest.json'), 'utf8'),
  ]);
  assert.equal(JSON.parse(manifestA).version, JSON.parse(manifestB).version);
  await Promise.all([fs.cp(sourcePackage, packageA, { recursive: true }), fs.cp(sourcePackage, packageB, { recursive: true })]);
  await Promise.all([fs.mkdir(home, { recursive: true }), fs.mkdir(parent, { recursive: true }), fs.mkdir(source, { recursive: true })]);
  await fs.writeFile(original, '# Disposable lifecycle fixture\nbluejay lifecycle needle\n');
  const originalHash = await digestFile(original);

  const first = startServer(packageA);
  try {
    await initialize(first);
    const started = await call(first, 'databrain_setup_start');
    assert.match(started, /Creating DataBrain under the parent selected in Claude Desktop settings/);
    const sourceState = await waitForStage(first, 'sources selected');
    assert.match(sourceState, /Selected source folders: 1/);
    assert.match(await call(first, 'databrain_setup_run'), /Indexing started/);
    await waitForStage(first, 'taxonomy pending');
    const hit = await call(first, 'databrain_search', { query: 'bluejay lifecycle needle' });
    assert.match(hit, /only-record\.md/, hit);
  } finally {
    await stop(first);
  }

  const dataBeforeReplacement = await treeDigest(dataHome);
  assert.equal(await digestFile(original), originalHash, 'indexing changed the selected original');

  const replacement = startServer(packageB);
  try {
    await initialize(replacement);
    const repeat = await call(replacement, 'databrain_setup_start');
    assert.match(repeat, /setup has already started/i, repeat);
    assert.equal(await treeDigest(dataHome), dataBeforeReplacement, 'repeated setup changed persisted DataBrain files');
    const hit = await call(replacement, 'databrain_search', { query: 'bluejay lifecycle needle' });
    assert.match(hit, /only-record\.md/, hit);
    const status = await call(replacement, 'databrain_setup_status');
    assert.match(status, /Stage: taxonomy pending\./, status);
    assert.equal(await digestFile(original), originalHash, 'replacement-process search changed the selected original');
  } finally {
    await stop(replacement);
  }

  const beforeRemoval = await treeDigest(dataHome);
  await fs.rm(packageB, { recursive: true, force: false });
  await assert.rejects(fs.access(packageB), { code: 'ENOENT' }, 'the simulated extension directory was not removed');
  assert.equal(await treeDigest(dataHome), beforeRemoval, 'removing the extension directory changed generated DataBrain data');
  assert.equal(await digestFile(original), originalHash, 'removing the extension directory changed the selected original');
  console.log('PASS: same-version local package-replacement/uninstall simulation preserved saved setup/search data and source bytes; not a Claude Desktop update/uninstall test.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
