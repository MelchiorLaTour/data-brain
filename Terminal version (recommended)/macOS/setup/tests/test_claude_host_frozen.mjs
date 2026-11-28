// Part 25 A: the Claude host (0.1.48 is published) and the frozen Codex branch serve byte-identical tools/list and instructions to the
// pre-part-25 snapshots, and the Claude host never needs hosts/chatgpt.mjs (the server is also run from a copy without the hosts folder).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const mcpDir = path.join(here, '../mcp');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-frozen-'));
async function snapshot(server, client) {
  const child = spawn(process.execPath, [server, '--databrain-client', client], { env: { PATH: process.env.PATH || '/usr/bin:/bin', HOME: path.join(temp, 'home'), TMPDIR: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map(); let n = 0; let stderr = '';
  child.stderr.setEncoding('utf8').on('data', c => { stderr += c; });
  readline.createInterface({ input: child.stdout }).on('line', l => { const m = JSON.parse(l); replies.get(m.id)?.(m); });
  const ask = (method, params) => new Promise((res, rej) => { const id = ++n; const t = setTimeout(() => rej(new Error(`timeout ${method}: ${stderr.slice(0, 300)}`)), 15000); replies.set(id, m => { clearTimeout(t); res(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const init = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: {} });
  const list = await ask('tools/list', {});
  child.kill();
  return JSON.stringify({ init: init.result, tools: list.result.tools }, null, 1);
}
try {
  for (const [client, fixture] of [['claude', 'claude-tools-before-part25.json'], ['codex', 'codex-tools-before-part25.json']]) {
    const want = (await fs.readFile(path.join(here, 'fixtures', fixture), 'utf8')).trimEnd();
    assert.equal(await snapshot(path.join(mcpDir, 'server.mjs'), client), want, `${client}: tools/list + instructions changed from the pre-part-25 snapshot`);
  }
  // The Claude package does not ship hosts/: a copy of the server tree without it must still serve the same Claude list.
  const copy = path.join(temp, 'mcp-no-hosts');
  await fs.cp(mcpDir, copy, { recursive: true, filter: source => path.basename(source) !== 'hosts' && path.basename(source) !== 'runtime' });
  await fs.cp(path.join(here, '../chatgpt/VERSION'), path.join(temp, 'chatgpt-VERSION')).catch(() => {});
  const want = (await fs.readFile(path.join(here, 'fixtures', 'claude-tools-before-part25.json'), 'utf8')).trimEnd();
  assert.equal(await snapshot(path.join(copy, 'server.mjs'), 'claude'), want, 'Claude host served a different list when hosts/ is absent');
  console.log('claude host frozen: PASS');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
