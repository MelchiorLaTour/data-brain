import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Desktop and Documents must be accepted as whole source folders; the whole home folder must still be refused.
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-source-roots-')));

function startServer(home, roots) {
  return startServerArgs(home, ['--databrain-parent', home, '--databrain-source-roots', ...roots]);
}

function startServerArgs(home, args) {
  const server = spawn(process.execPath, [serverScript, ...args],
    { env: { ...process.env, HOME: home, DATABRAIN_TEST_STEP_BY_STEP: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  return { server, request };
}

async function runSetup(home, roots, phrase) {
  const client = startServer(home, roots);
  try {
    await client.request('initialize', { protocolVersion: '2025-03-26' });
    client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await client.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    for (let attempt = 0; attempt < 400; attempt += 1) {
      const status = (await client.request('tools/call', { name: 'databrain_setup_status', arguments: {} })).result.content[0].text;
      if (status.includes(phrase)) return status;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.fail(`Timed out waiting for "${phrase}"`);
  } finally { client.server.kill(); }
}

try {
  const okHome = path.join(temp, 'ok-home');
  await fs.mkdir(path.join(okHome, 'Desktop'), { recursive: true });
  await fs.mkdir(path.join(okHome, 'Documents'), { recursive: true });
  const canonicalOk = await fs.realpath(okHome);
  await runSetup(canonicalOk, [path.join(canonicalOk, 'Desktop'), path.join(canonicalOk, 'Documents')], 'Stage: sources selected');
  const saved = await fs.readFile(path.join(canonicalOk, 'DataBrain', '.source-roots'), 'utf8');
  assert.equal(saved, `${canonicalOk}/Desktop\n${canonicalOk}/Documents\n`, 'Desktop and Documents must be saved as source folders');

  const badHome = path.join(temp, 'bad-home');
  await fs.mkdir(path.join(badHome, 'Desktop'), { recursive: true });
  const canonicalBad = await fs.realpath(badHome);
  const refused = await runSetup(canonicalBad, [canonicalBad], 'cannot contain DataBrain');
  assert(refused.includes('cannot contain DataBrain'), refused);
  await assert.rejects(fs.readFile(path.join(canonicalBad, 'DataBrain', '.source-roots'), 'utf8'), { code: 'ENOENT' }, 'the home folder must not be saved as a source');

  // Desktop shows the default as literal "${HOME}", and a blank setting may arrive as no value: both must mean the home folder.
  for (const [label, parentArgs] of [['literal ${HOME}', ['${HOME}']], ['no value', []]]) {
    const literalHome = path.join(temp, `literal-${parentArgs.length}`);
    await fs.mkdir(path.join(literalHome, 'Desktop'), { recursive: true });
    const canonicalLiteral = await fs.realpath(literalHome);
    const client = startServerArgs(canonicalLiteral, ['--databrain-parent', ...parentArgs, '--databrain-source-roots', path.join(canonicalLiteral, 'Desktop')]);
    try {
      await client.request('initialize', { protocolVersion: '2025-03-26' });
      client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      await client.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
      let status = '';
      for (let attempt = 0; attempt < 400 && !status.includes('Stage: sources selected'); attempt += 1) {
        status = (await client.request('tools/call', { name: 'databrain_setup_status', arguments: {} })).result.content[0].text;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(status.includes('Stage: sources selected'), `${label}: ${status}`);
      await fs.stat(path.join(canonicalLiteral, 'DataBrain', '.source-roots'));
    } finally { client.server.kill(); }
  }

  console.log('PASS: Desktop and Documents are accepted as whole source folders; the whole home folder is refused; a literal ${HOME} or blank parent means the home folder.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
