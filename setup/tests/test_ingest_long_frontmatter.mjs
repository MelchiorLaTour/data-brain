// Part 19 A (0.2.1): a Markdown file whose frontmatter is long (more than 200 lines) or never closes was "left out" on EVERY pass ("1 file(s) left out, retried
// next pass"): no index row was ever written, so the next freshness check found it "added" again and started another refresh, back to back, forever (real Mac,
// 2026-11-16: a downloaded model card README, 497 KB, front matter longer than the engine reads). A stable file like that is indexed, with no tags.
// Fake HOME, invented files. Run with DATABRAIN_TEST_CLIENT=claude and chatgpt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-longfm-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 300000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\nlongfmplainmarker an ordinary note.\n');
// 300 frontmatter lines, never closed (a model card carries thousands of metadata lines)
await fs.writeFile(path.join(realDocs, 'modelcard.md'), `---\n${Array.from({ length: 300 }, (_, i) => `metric_${i}: ${i}`).join('\n')}\n\n# Model card\nlongfmbodymarker the text after a very long header.\n`);
// frontmatter that opens and never closes at all
await fs.writeFile(path.join(realDocs, 'unclosed.md'), '---\ntitle: never closed\n\n# Unclosed\nlongfmunclosedmarker text.\n');

const dataHome = path.join(home, 'DataBrain');
const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100' }, stdio: ['pipe', 'pipe', 'ignore'] });
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  if (chatgpt) { await call('databrain_setup_start', { folders: [realDocs] }); await call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await call('databrain_setup_start');
  let lastStatus = '';
  await until(async () => {
    lastStatus = await call('databrain_setup_status');
    if (lastStatus.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(lastStatus);
  }, 'setup reaches ready (before the fix a file with a very long frontmatter stopped the first index build: build-index.sh exit 2)', 240000).catch(error => { throw new Error(`${error.message}\nlast status:\n${lastStatus.slice(0, 600)}`); });
  await sleep(2000);
  const index = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  for (const name of ['plain.md', 'modelcard.md', 'unclosed.md']) assert(index.includes(`/${name}\t`), `${name} has an index row`);
  for (const [query, name] of [['longfmbodymarker', 'modelcard'], ['longfmunclosedmarker', 'unclosed'], ['longfmplainmarker', 'plain']]) assert(new RegExp(name).test(await call('databrain_search', { query })), `${name} is found by search`);
  // no endless refresh: a few searches later the index is current, no "changes are being added" line, and no file is "left out"
  for (let i = 0; i < 3; i++) { await sleep(1500); await call('databrain_search', { query: 'longfmplainmarker' }); }
  await sleep(4000);
  const again = await call('databrain_search', { query: 'longfmplainmarker' });
  assert(!/New changes are being added|Freshness:/.test(again), `the index is current (no freshness warning):\n${again.slice(0, 300)}`);
  const log = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '');
  assert(!/ingest-skipped/.test(log), `no file was left out of an ingest pass:\n${log.split('\n').filter(l => /ingest-skipped/.test(l)).join('\n')}`);
  const refreshStarts = log.split('\n').filter(line => /\trefresh\t[0-9a-f]+\tjob-start\t/.test(line)).length;
  assert(refreshStarts <= 2, `no refresh loop (${refreshStarts} refresh jobs after setup)`);
  console.log(`PASS: a stable Markdown file with a very long or unclosed frontmatter is indexed once, with no tags; no file is left out and no refresh repeats (${chatgpt ? 'ChatGPT' : 'Claude'} host, ${refreshStarts} refresh job(s))`);
} finally { child.kill('SIGKILL'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }); }
