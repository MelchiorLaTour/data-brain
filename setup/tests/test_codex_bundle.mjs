import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';

const bundle = path.resolve(process.argv[2] || '');
assert(bundle.endsWith('.app'), 'pass one DataBrain MCP.app bundle');
const contents = path.join(bundle, 'Contents');
const executable = path.join(contents, 'MacOS', 'databrain-mcp');
const resources = path.join(contents, 'Resources');
const packageModule = await import(pathToFileURL(path.join(resources, 'setup/mcp/package-identity.mjs')));
const identity = await packageModule.readCodexPackageIdentity(contents);
assert.equal(identity.kind, 'codex');
assert.equal(identity.packageInfo.version, '0.1.0');
assert.ok(['darwin-arm64', 'darwin-x64'].includes(identity.packageInfo.architecture));
assert.equal(identity.packageInfo.runtime_version, identity.build.runtime_version);
assert.equal(identity.packageInfo.minimum_macos, '14.0');
const nodePath = path.join(contents, 'Frameworks/node/bin/node');
const nodeBytes = await fs.readFile(nodePath);
assert.equal(nodeBytes.readUInt32LE(0), 0xfeedfacf, 'bundled Node must be a 64-bit Mach-O executable');
const nodeCommands = nodeBytes.readUInt32LE(16);
let commandOffset = 32;
let nodeMinimum = null;
for (let index = 0; index < nodeCommands; index += 1) {
  const command = nodeBytes.readUInt32LE(commandOffset);
  const commandSize = nodeBytes.readUInt32LE(commandOffset + 4);
  if (command === 0x32) {
    const packed = nodeBytes.readUInt32LE(commandOffset + 12);
    nodeMinimum = `${(packed >>> 16) & 255}.${(packed >>> 8) & 255}.${packed & 255}`;
    break;
  }
  if (command === 0x24) {
    const packed = nodeBytes.readUInt32LE(commandOffset + 8);
    nodeMinimum = `${(packed >>> 16) & 255}.${(packed >>> 8) & 255}.${packed & 255}`;
    break;
  }
  assert(commandSize >= 8, 'Mach-O load command size must be valid');
  commandOffset += commandSize;
}
assert(nodeMinimum, 'bundled Node must declare its minimum macOS version');
const asTuple = version => version.split('.').map(Number);
const compareVersion = (left, right) => {
  const a = asTuple(left); const b = asTuple(right);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
};
assert(compareVersion(identity.packageInfo.minimum_macos, nodeMinimum) >= 0,
  `bundle minimum ${identity.packageInfo.minimum_macos} is below Node minimum ${nodeMinimum}`);
assert.match(await fs.readFile(path.join(contents, 'Info.plist'), 'utf8'),
  /<key>LSMinimumSystemVersion<\/key>\s*<string>14\.0<\/string>/);
assert((await fs.stat(executable)).mode & 0o111, 'MCP launcher is executable');
assert((await fs.stat(path.join(contents, 'Frameworks/node/bin/node'))).mode & 0o111, 'bundled Node is executable');
assert((await fs.stat(path.join(resources, 'runtime/bin/rg'))).mode & 0o111, 'bundled ripgrep is executable');

const hostArch = os.arch() === 'arm64' ? 'darwin-arm64' : os.arch() === 'x64' ? 'darwin-x64' : 'unsupported';
let launchPrefix = [];
let canRun = identity.packageInfo.architecture === hostArch;
let usedRosetta = false;
if (!canRun && hostArch === 'darwin-arm64' && identity.packageInfo.architecture === 'darwin-x64') {
  const translated = spawnSync('/usr/bin/arch', ['-x86_64', path.join(contents, 'Frameworks/node/bin/node'), '--version'], { encoding: 'utf8' });
  if (translated.status === 0) { canRun = true; usedRosetta = true; }
}
if (canRun) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-codex-bundle-'));
  const [command, prefixArgs = []] = launchPrefix.length ? launchPrefix : [executable, []];
  const server = spawn(command, [...prefixArgs, ...(launchPrefix.length ? [executable] : [])], {
    env: { HOME: home, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', part => { stderr += part; });
  const lines = readline.createInterface({ input: server.stdout });
  const pending = new Map();
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
  });
  let nextId = 1;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method} timed out. ${stderr}`)); }, 5000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26' });
    assert.equal(initialized.result.serverInfo.name, 'databrain');
    assert.match(initialized.result.instructions, /one permission dialog/);
    const listed = await request('tools/list');
    assert(listed.result.tools.some(tool => tool.name === 'databrain_setup_start'));
    const status = await request('tools/call', { name: 'databrain_setup_status', arguments: {} });
    assert.match(status.result.content[0].text, /Stage: not configured/);
    assert.match(status.result.content[0].text, /Connection:/);
    assert.equal(await fs.readdir(home).then(entries => entries.length), 0, 'initialize and status do not create setup state');
    process.stdout.write(`PASS: ${identity.packageInfo.architecture} bundle payload, pinned runtime, MCP initialize/tools/status, and no-state startup verified under restricted PATH${usedRosetta ? ' with Rosetta' : ''}.\n`);
  } finally {
    server.kill('SIGTERM');
    await new Promise(resolve => server.once('close', resolve));
    await fs.rm(home, { recursive: true, force: true });
  }
} else {
  process.stdout.write(`PARTIAL: ${identity.packageInfo.architecture} bundle metadata and payload verified; the current host cannot execute ${identity.packageInfo.architecture}.\n`);
}
