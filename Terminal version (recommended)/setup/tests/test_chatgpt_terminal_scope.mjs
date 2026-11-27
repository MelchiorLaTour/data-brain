// Part 41: the ChatGPT-app DataBrain must not take over Codex in Terminal. Both read ~/.codex/config.toml, and both send the same MCP clientInfo
// ("codex-mcp-client", proven from real handshakes), so clientInfo cannot tell them apart. The ChatGPT app's app-server is started with
// CODEX_INTERNAL_ORIGINATOR_OVERRIDE set; the installer's env_vars line forwards it to DataBrain, and the Codex CLI in Terminal does not have it.
// With --databrain-desktop-only and no such variable, the server lists no tools, sends empty instructions and writes nothing. Fake HOME only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startChatgpt } from './chatgpt-harness.mjs';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'databrain-terminal-scope-'));
const NOT_ACTIVE = 'DataBrain for the ChatGPT app is not active in the Codex terminal.';
// Exact initialize params from the real handshakes (codex-cli 0.172.0 in Terminal; ChatGPT.app bundled app-server 0.171.0-alpha.13.2).
const handshake = version => ({ protocolVersion: '2025-06-18', capabilities: { experimental: { 'codex/auth-change': {} }, elicitation: { form: {}, url: {} } }, clientInfo: { name: 'codex-mcp-client', title: 'Codex', version } });

async function session(label, { env = {}, desktopOnly = true, version }) {
  const home = path.join(temp, label);
  fs.mkdirSync(home, { recursive: true });
  const before = fs.readdirSync(home);
  const server = startChatgpt({ home, extraArgs: ['--databrain-client', 'chatgpt', ...(desktopOnly ? ['--databrain-desktop-only'] : [])], env: { ...env } });
  try {
    const init = (await server.ask('initialize', handshake(version))).result;
    const tools = (await server.ask('tools/list', {})).result.tools.map(tool => tool.name);
    const call = (await server.ask('tools/call', { name: 'databrain_search', arguments: { query: 'garden' } })).result?.content?.[0]?.text ?? '';
    return { init, tools, call, home, before };
  } finally { await server.stop(); }
}

try {
  // The startChatgpt harness spreads process.env; make sure the runner's own environment cannot fake the desktop signal.
  for (const key of Object.keys(process.env)) if (key === 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE') delete process.env[key];

  // G1a: Codex CLI in Terminal (no originator variable reaches the child) -> inert
  const cli = await session('cli', { version: '0.172.0' });
  assert.equal(cli.init.serverInfo.name, 'databrain');
  assert.deepEqual(cli.tools, [], `Codex terminal: no DataBrain tools may be listed, got ${cli.tools.join(', ')}`);
  assert.equal(cli.init.instructions, '', 'Codex terminal: instructions must be empty');
  assert.equal(cli.call, NOT_ACTIVE, 'Codex terminal: a direct call is answered with the plain not-active line');
  assert.deepEqual(fs.readdirSync(cli.home), cli.before, 'Codex terminal: the stood-down server writes nothing in HOME');

  // An empty or blank variable is no desktop signal either.
  const blank = await session('blank', { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: '  ' }, version: '0.172.0' });
  assert.deepEqual(blank.tools, [], 'a blank originator variable is not the ChatGPT app');

  // G1b: the ChatGPT desktop app (app-server sets the variable, env_vars forwards it) -> full tools
  const app = await session('app', { env: { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, version: '0.171.0-alpha.13.2' });
  assert(app.tools.includes('databrain_search') && app.tools.length >= 20, `ChatGPT app: full tools, got ${app.tools.length}`);
  assert(app.init.instructions.length > 0, 'ChatGPT app: the host instructions are sent');
  assert.notEqual(app.call, NOT_ACTIVE);

  // Without the flag (an older install, tests, the Claude host) nothing changes.
  const legacy = await session('legacy', { desktopOnly: false, version: '0.172.0' });
  assert(legacy.tools.includes('databrain_search'), 'without --databrain-desktop-only the server behaves as before');

  console.log('PASS: ChatGPT-app DataBrain stands down under the Codex CLI (no tools, empty instructions, nothing written) and runs in full under the ChatGPT app');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
