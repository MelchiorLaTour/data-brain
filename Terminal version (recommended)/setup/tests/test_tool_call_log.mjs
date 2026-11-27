// Part 23 (0.2.1): every tool call leaves ONE line in stage-timing.log: tool name, duration, ok or err. Never the arguments, never the result, so the log can
// prove "DataBrain was called at this time" for a chat without holding anything from it. Both hosts. Fake HOME, invented data.
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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-calllog-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\ncalllogdocbodymarker an ordinary note.\n');
const dataHome = path.join(home, 'DataBrain');
const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const callLines = async () => (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(line => /\t-\t-\ttool-call\t/.test(line));
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  if (chatgpt) { await call('databrain_setup_start', { folders: [realDocs] }); await call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await call('databrain_setup_start');
  await until(async () => {
    const status = await call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready');
  const before = (await callLines()).length;
  const SECRET_QUERY = 'zzcalllogsecretquery'; const MISSING = path.join(realDocs, 'zz-calllog-missing-file.md');
  const found = await call('databrain_search', { query: 'calllogdocbodymarker' });
  assert(/calllogdocbodymarker/.test(found), 'the search finds the invented note');
  await call('databrain_search', { query: SECRET_QUERY });
  await call('databrain_read', { path: MISSING });
  await call('definitely_not_a_tool"; rm -rf', { x: SECRET_QUERY });
  await sleep(500);
  const lines = (await callLines()).slice(before);
  assert.equal(lines.length, 4, `one line per call (4 calls):\n${lines.join('\n')}`);
  const shape = /^\d{4}-\d\d-\d\dT[\d:.]+Z\t-\t-\ttool-call\t\d+ms\t(databrain_[a-z_]+|unknown-tool) (ok|err( (bad-keywords|bad-title|bad-body|bad-folder|bad-arguments|busy-or-restart|no-answer|other))?)$/;
  for (const line of lines) assert(shape.test(line), `a call line is time, duration, tool, ok/err and nothing else: ${line}`);
  assert(/databrain_search ok$/.test(lines[0]) && /databrain_search ok$/.test(lines[1]), 'a search is "ok"');
  assert(/databrain_read err( [a-z-]+)?$/.test(lines[2]), 'a read of a missing file is "err"');
  assert(/unknown-tool err( [a-z-]+)?$/.test(lines[3]), 'a tool name that is not ours is logged as unknown-tool, never as typed');
  const wholeLog = await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8');
  for (const never of [SECRET_QUERY, 'calllogdocbodymarker', 'zz-calllog-missing-file', 'rm -rf']) assert(!wholeLog.includes(never), `the log never holds arguments or results: found ${never}`);
  const report = await call('databrain_diagnostics');
  assert(!/tool-call/.test(report) && /job-|initial indexing|refresh|index housekeeping/.test(report), `the diagnostics report keeps showing job lines, not one line per call:\n${report.slice(-600)}`);
  console.log(`PASS: ${chatgpt ? 'ChatGPT' : 'Claude'} host: every tool call leaves one line (tool name, ms, ok/err); no query, path, document text or typed tool name reaches the log.`);
} finally { child.kill('SIGKILL'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }); }
