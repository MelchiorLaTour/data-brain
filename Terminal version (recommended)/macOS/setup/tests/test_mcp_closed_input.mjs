// The server stops what it started as soon as its input closes (the app is stopping the extension). One-shot use, where a caller pipes its
// requests in and closes the input, must still get its answers:
//   1) a few calls piped in, input closed at once: every call is answered, and the server leaves;
//   2) a search that needs a refresh, input closed at once: the answer has the changed note;
//   3) the input closed while that refresh is running: the call is still answered (fresh, or with the plain note that the update did not
//      finish) and the server leaves within seconds.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-closed-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const root = await fs.realpath(docs);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
await fs.writeFile(path.join(root, 'a.md'), '# A\nclosedinputmarker an ordinary note.\n');
await fs.writeFile(path.join(root, 'b.md'), '# B\nanother ordinary note.\n');

// requests go in together, the input closes after `eofAfterMs`; resolves with every answer and how long the server took to leave after the close
function piped(requests, { eofAfterMs = 0, env = {} } = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', root], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    const answers = new Map(); let closedAt = null;
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); answers.set(m.id, m); });
    child.stdin.write(requests.map((r, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...r })).join('\n') + '\n');
    setTimeout(() => { closedAt = Date.now(); child.stdin.end(); }, eofAfterMs);
    const guard = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('exit', () => { clearTimeout(guard); resolve({ answers, leftAfterMs: Date.now() - closedAt }); });
  });
}
const call = (name, args = {}) => ({ method: 'tools/call', params: { name, arguments: args } });
const text = (answers, id) => answers.get(id)?.result?.content?.[0]?.text ?? '';
const init = { method: 'initialize', params: { protocolVersion: '2025-03-26' } };

const servers = [];
try {
  // 1) calls piped in, input closed at once
  let r = await piped([init, { method: 'tools/list', params: {} }, call('databrain_setup_status')]);
  assert.equal(r.answers.size, 3, `every piped call is answered: ${[...r.answers.keys()]}`);
  assert(r.answers.get(2).result.tools.length > 5, 'tools/list answered with the tools');
  assert(r.leftAfterMs < 5000, `the server leaves after the last answer: ${r.leftAfterMs} ms`);

  // a ready brain to search
  const first = spawn(process.execPath, [serverScript, '--databrain-source-roots', root], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] }); servers.push(first);
  const waiting = new Map(); let n = 100;
  readline.createInterface({ input: first.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); first.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  await ask('initialize', { protocolVersion: '2025-03-26' }); first.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await ask('tools/call', { name: 'databrain_setup_start', arguments: {} });
  for (const t0 = Date.now(); ; await sleep(500)) {
    const status = (await ask('tools/call', { name: 'databrain_setup_status', arguments: {} })).result?.content?.[0]?.text ?? '';
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await ask('tools/call', { name: 'databrain_privacy', arguments: { action: 'decide', keep: [] } });
    if (/Stage: ready\./.test(status)) break;
    assert(Date.now() - t0 < 120000, 'setup reaches ready');
  }
  first.kill('SIGTERM'); await new Promise(resolve => { first.once('exit', resolve); setTimeout(resolve, 5000); });

  // 2) a changed note, a search piped in, input closed at once: the answer has the note
  await fs.appendFile(path.join(root, 'b.md'), '\nclosedinputnewword added after setup.\n');
  r = await piped([init, call('databrain_search', { query: 'closedinputnewword' })], { env: { DATABRAIN_FRESHNESS_CHECK_MS: '100' } });
  assert.equal(r.answers.size, 2, 'the search is answered');
  assert(/b\.md/.test(text(r.answers, 2)), `the answer has the changed note:\n${text(r.answers, 2)}`);
  assert(r.leftAfterMs < 8000, `the server leaves: ${r.leftAfterMs} ms`);

  // 3) the input closes while the refresh is running
  await fs.appendFile(path.join(root, 'b.md'), '\nclosedinputlaterword added later.\n');
  r = await piped([init, call('databrain_search', { query: 'closedinputlaterword' })], { eofAfterMs: 2900, env: { DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_UPDATE_DELAY_MS: '2500' } });
  assert.equal(r.answers.size, 2, 'the search is answered even though the input closed during the refresh');
  assert(/b\.md|did not finish|being added/.test(text(r.answers, 2)), `the answer has the note or says plainly the update did not finish:\n${text(r.answers, 2)}`);
  assert(r.leftAfterMs < 8000, `the server leaves within seconds of the close: ${r.leftAfterMs} ms`);

  console.log('PASS: calls piped in with the input closed at once are all answered (and the changed note is found); an input closed during a refresh still gets its answer, and the server leaves within seconds.');
} finally {
  for (const x of servers) x.kill('SIGKILL');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
