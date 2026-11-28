// A note that a search found is opened by databrain_read at the place the search matched (0.1.31), unless the caller gives an offset. The position line
// says how much text comes before it. A note whose match is at the start, or an explicit offset, behaves as before.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-readmatch-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const filler = word => Array.from({ length: 700 }, (_, i) => `${word}${i % 29}`).join(' ');
await fs.writeFile(path.join(docs, 'deep.md'), `# Deep note\n${filler('before')}\nthe readzulu finding is the secretphrase worth opening.\n${filler('after')}\n`);
await fs.writeFile(path.join(docs, 'top.md'), `# Top note\nthe topzulu finding is at the very start.\n${filler('after')}\n`);
let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 700000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => (await tool('databrain_search', { query: 'readzulu' })).includes('deep.md'), 'notes are searchable');
  await sleep(1500);
  const deep = path.join(docs, 'deep.md');
  const found = await tool('databrain_search', { query: 'readzulu' });
  assert(found.includes('deep.md'), 'search returns the deep note');
  const opened = await tool('databrain_read', { path: deep });
  const total = Number(/Characters [\d,]+-[\d,]+ of ([\d,]+)/.exec(opened)?.[1].replace(/,/g, ''));
  const startsAt = Number(/Characters ([\d,]+)-/.exec(opened)?.[1].replace(/,/g, ''));
  assert(startsAt > 2000 && total > startsAt, `without an offset the piece starts at the match (character ${startsAt} of ${total}):\n${opened.slice(0, 400)}`);
  assert(opened.includes('secretphrase'), `the piece holds the matched words:\n${opened.slice(0, 600)}`);
  assert(new RegExp(`This piece starts at the place the search matched; characters 0-${startsAt.toLocaleString('en-US')} come before it\\.`).test(opened), `the position line says how much comes before:\n${opened.slice(0, 400)}`);
  const fromStart = await tool('databrain_read', { path: deep, offset: 0 });
  assert(/Characters 0-1,200 of /.test(fromStart) && !fromStart.includes('secretphrase') && !/starts at the place/.test(fromStart), `offset 0 reads from the beginning:\n${fromStart.slice(0, 300)}`);
  const onward = await tool('databrain_read', { path: deep, offset: startsAt + 1200 });
  assert(new RegExp(`Characters ${(startsAt + 1200).toLocaleString('en-US')}-`).test(onward) && !/starts at the place/.test(onward), 'reading onward by offset is unchanged');
  const topFound = await tool('databrain_search', { query: 'topzulu' });
  assert(topFound.includes('top.md'), 'search returns the top note');
  const top = await tool('databrain_read', { path: path.join(docs, 'top.md') });
  assert(/Characters 0-1,200 of /.test(top) && !/starts at the place/.test(top), `a match at the very start opens at 0 with no extra line:\n${top.slice(0, 300)}`);
  const spec = (await ask('tools/list', {})).result.tools.find(candidate => candidate.name === 'databrain_read');
  assert(/place the search matched/.test(spec.description) && /offset 0/.test(spec.description), 'the description tells Claude about the match and offset 0');
  console.log('PASS: a read after a search opens at the matched place with a line saying how much comes before; offset 0, onward offsets and matches at the start are unchanged.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
