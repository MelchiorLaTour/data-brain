// Part 13 (0.2.1), item 1: in ChatGPT "save a note" was answered with the model's own file tool (a stray .txt in a chat folder) and databrain_capture was never
// called. The server's instructions stay at their pinned 553 characters (test_mcp_tool_guidance_budget), so the routing lives in the tool description the host always has. It must send "save a note / remember this / note that / write
// this down" to databrain_capture and forbid a file tool of the model's own. What the model then CHOOSES cannot be tested without the real app; the exact
// prompt for that run is in REPORT-0.2.1-part13.md.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-routing-')));
try {
  for (const client of ['claude', 'chatgpt']) {
    const home = path.join(temp, `home-${client}`); const docs = path.join(temp, `docs-${client}`);
    await fs.mkdir(home, { recursive: true }); await fs.mkdir(docs, { recursive: true });
    const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_TEST_CLIENT: client }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(); let id = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
    const ask = (method, params) => new Promise(resolve => { const n = ++id; waiting.set(n, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); });
    try {
      const init = await ask('initialize', { protocolVersion: '2025-03-26' });
      child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      const instructions = init.result?.instructions || '';
      const tools = (await ask('tools/list', {})).result.tools;
      const capture = tools.find(tool => tool.name === 'databrain_capture');
      for (const phrase of ['save a note', 'remember this', 'note that', 'write this down']) assert(capture.description.includes(phrase), `${client}: the tool description names "${phrase}"`);
      assert(/^When the user says save a note, remember this, note that, write this down or capture an idea, call this tool; never write the note with a file tool of your own/.test(capture.description), `${client}: the tool description starts with the routing:\n${capture.description.slice(0, 300)}`);
      assert(!/Claude/.test(client === 'chatgpt' ? capture.description : ''), 'ChatGPT hears nothing about Claude in it');
      console.log(`  ${client}: the databrain_capture description routes "save a note" to databrain_capture`);
    } finally { child.kill('SIGKILL'); }
  }
  console.log('PASS: the databrain_capture description sends "save a note / remember this / note that / write this down" to databrain_capture in both hosts.');
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => {});
}
