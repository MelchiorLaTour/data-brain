// 0.1.43: a brand-new brain (first build screened by the current rules) must answer its very first question normally. The privacy gate must not say
// "re-checking" for it, at any stage after setup, and the first build must record the privacy rules version.
// Package under test = DATABRAIN_SERVER (a server.mjs). Mutant (NEWBRAIN_MUTANT=no-first-build-version): the first build does not record the version.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fakeHome, initialize, setupToReady, sleep } from './mcp-harness-0138.mjs';

const { temp, home, docs, statePath } = await fakeHome('new-brain');
let serverPath = process.env.DATABRAIN_SERVER;
assert(serverPath, 'DATABRAIN_SERVER is required');
if (process.env.NEWBRAIN_MUTANT) {
  const copy = path.join(temp, 'mutant');
  await fs.cp(path.resolve(path.dirname(serverPath), '..', '..'), copy, { recursive: true });
  const mutantServer = path.join(copy, 'setup', 'mcp', 'server.mjs');
  let s = await fs.readFile(mutantServer, 'utf8'); const before = s;
  s = s.replace("    if (!codexMode) await writeState({ ...(await readState()), privacyRulesVersion: PRIVACY_RULES_VERSION });", '');
  assert.notEqual(s, before, 'mutant applied');
  await fs.writeFile(mutantServer, s); serverPath = mutantServer;
}
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\nnewbrainmarker tomatoes need staking.\n');
const child = spawn(process.execPath, [serverPath, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const server = { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
try {
  await initialize(server);
  await setupToReady(server);
  const first = await server.tool('databrain_search', { query: 'newbrainmarker' });
  console.log('=== FIRST QUESTION OF A NEW BRAIN ===\n' + first + '\n=== END ===');
  assert(!first.includes('re-checking'), `a new brain does not say "re-checking":\n${first}`);
  assert(first.includes('plan.md'), `the first question finds the note:\n${first}`);
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  assert.equal(state.privacyRulesVersion, '0.1.38', 'the first build recorded the privacy rules version');
  console.log('PASS new brain first answer');
} finally {
  child.kill('SIGTERM'); await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
