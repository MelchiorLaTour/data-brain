// Shared by the 0.2.1 ChatGPT-host tests: start the server as the ChatGPT host in a fake HOME. No folder list is passed at launch:
// ChatGPT has no settings screen, so the user names the folders in the chat. Invented data only.
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { serverScript, sleep, until } from './mcp-harness-0138.mjs';

export { fakeHome, here, initialize, sleep, until } from './mcp-harness-0138.mjs';

// extraArgs: for the "same questions in both hosts" test, pass ['--databrain-client', 'claude', '--databrain-source-roots', ...roots].
export function startChatgpt({ home, env = {}, nodeArgs = [], extraArgs = null, script = process.env.DATABRAIN_SERVER || serverScript, node = process.execPath }) {
  const args = [...nodeArgs, script, ...(extraArgs || ['--databrain-client', 'chatgpt'])];
  const child = spawn(node, args, { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const waiting = new Map(); let n = 0;
  // A client that shows forms: the server's elicitation/create arrives as a request; `server.elicitAnswer` (set by the test) decides the user's click.
  const elicitations = [];
  const server = { elicitAnswer: null };
  readline.createInterface({ input: child.stdout }).on('line', async line => {
    try {
      const m = JSON.parse(line);
      if (m.method === 'elicitation/create') {
        elicitations.push(m.params);
        const result = server.elicitAnswer ? await server.elicitAnswer(m.params) : { action: 'cancel' };
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: m.id, result })}\n`, () => {});
        return;
      }
      waiting.get(m.id)?.(m);
    } catch {}
  });
  // A server that exits (for example a build that does not know --databrain-client chatgpt) fails the test at once, with its own error text.
  let exited = null;
  child.once('exit', code => {
    exited = { error: { message: `server exited with code ${code}: ${stderr.trim().split('\n').slice(0, 3).join(' | ')}` } };
    for (const resolve of waiting.values()) resolve(exited);
  });
  const ask = (method, params) => new Promise(resolve => {
    if (exited) return resolve(exited);
    const id = ++n; waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, () => {});
  });
  const tool = async (name, args = {}) => { const reply = await ask('tools/call', { name, arguments: args }); return reply.result?.content?.[0]?.text ?? reply.error?.message ?? ''; };
  child.stdin.on('error', () => {});   // writing to a server that already exited is reported through ask()
  const initialize = async (capabilities = undefined) => {
    const reply = await ask('initialize', { protocolVersion: '2025-03-26', ...(capabilities ? { capabilities } : {}) });
    if (reply.error) throw new Error(reply.error.message);
    child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return reply.result;
  };
  const stop = () => new Promise(resolve => { if (child.exitCode !== null) return resolve(); child.once('exit', resolve); child.kill(); });
  return { child, ask, tool, initialize, stop, stderr: () => stderr, elicitations, answerWith: fn => { server.elicitAnswer = fn; } };
}

// The user's two messages in the chat: name the folders, then say yes. Waits for "Stage: ready." and keeps nothing held (privacy review).
export async function setupFromChat(server, folders, { decide = { keep: [] }, limit = 240000 } = {}) {
  await server.tool('databrain_setup_start', { folders });   // shows the list; nothing is created until the yes below
  await server.tool('databrain_setup_start', { folders, confirmed: true });
  await until(async () => {
    const status = await server.tool('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', ...decide });
    return /Stage: ready\./.test(status);
  }, 'setup reached ready', limit);
}

export async function writeNotes(dir, notes) {
  await fs.mkdir(dir, { recursive: true });
  for (const [name, text] of Object.entries(notes)) await fs.writeFile(path.join(dir, name), text);
}

export { sleep as wait };
