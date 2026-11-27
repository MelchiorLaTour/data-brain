// databrain_search pages are filled by size (0.1.31): up to 100 hits by default, the top 5 with a full excerpt, the rest with ONE short line (title,
// date, a shorter excerpt), and a page never goes past 40,000 bytes. The next page starts after the last hit shown, so nothing is skipped.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-compact-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
const longDir = path.join(docs, 'x'.repeat(120), 'y'.repeat(120));   // long paths: 100 hits would be far over 40 KB
await fs.mkdir(longDir, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const pad = n => String(n).padStart(3, '0');
for (let i = 1; i <= 60; i++) await fs.writeFile(path.join(docs, `small-${pad(i)}.md`), `# Small note ${i}\nThe compactzulu detail of small note ${i} is ownmark${pad(i)} and the text goes on for a good while so the excerpt has to be cut short, well past one hundred characters in all.\n`);
for (let i = 1; i <= 100; i++) await fs.writeFile(path.join(longDir, `${'long-name-'.repeat(12)}${pad(i)}.md`), `# ${'Very long title '.repeat(12)}${i}\nThe capzulu detail of long note ${i} is ownlong${pad(i)} and the text goes on for a good while so the excerpt has to be cut short, well past one hundred characters.\n`);

let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 700000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const rankLines = text => text.split('\n').filter(line => /^\s*\d+\s+-?[0-9.]+\s+\S/.test(line));

try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => /of 60\./.test(await tool('databrain_search', { query: 'compactzulu' })) && /of 100\./.test(await tool('databrain_search', { query: 'capzulu' })), 'notes are searchable');
  await sleep(1500);

  // default page: all 60, top 5 full, the rest one short line each
  const page = await tool('databrain_search', { query: 'compactzulu' });
  assert(/^.*Results 1-60 of 60\./m.test(page), `the default page holds up to 100 hits (all 60 here):\n${page.slice(0, 300)}`);
  const lines = page.split('\n');
  assert.equal(rankLines(page).length, 60, 'sixty ranked lines');
  assert.equal((page.match(/^From your files:/gm) || []).length, 5, 'only the top 5 hits carry the source line');
  assert.equal((page.match(/^\s+excerpt: /gm) || []).length, 5, 'only the top 5 hits carry a full excerpt line');
  const at = lines.findIndex(line => /^\s*6\s+-?[0-9.]+\s/.test(line));
  assert(at > 0, 'a sixth hit exists');
  const compact = lines[at + 1];
  assert(/^ {6}Small note \d+ · \d{4}-\d{2}-\d{2} · …?The compactzulu detail/.test(compact) || /^ {6}small-\d+ · \d{4}-\d{2}-\d{2} · /.test(compact) || /^ {6}Small note \d+ · \d{4}-\d{2}-\d{2} · /.test(compact), `a later hit has one compact line (title · date · excerpt):\n${compact}`);
  const text = compact.split(' · ')[2] || '';
  assert(text.length > 20 && text.length <= 100, `the compact excerpt is at most 100 characters (${text.length}):\n${compact}`);
  assert(!/ownmark\d+.*ownmark\d+/.test(compact), 'one hit, one excerpt');
  const full = lines[lines.findIndex(line => /^\s*1\s+-?[0-9.]+\s/.test(line)) + 1];
  assert(/^\s+excerpt: /.test(full) && full.length > 120, `the top hit keeps the longer excerpt:\n${full}`);

  // a caller can ask for fewer; the second default page continues at 41
  const small = await tool('databrain_search', { query: 'compactzulu', limit: 3 });
  assert(/Results 1-3 of 60\./.test(small) && rankLines(small).length === 3, 'limit still sets the page size');
  const forty = await tool('databrain_search', { query: 'compactzulu', limit: 40 });
  assert(/Results 1-40 of 60\./.test(forty), 'a page of 40');
  const second = await tool('databrain_search', { query: 'compactzulu', limit: 40, offset: 40 });
  assert(/Results 41-60 of 60\./.test(second) && rankLines(second).length === 20, `the second page holds the other 20:\n${second.slice(0, 200)}`);

  // the size cap: long paths, 100 hits asked for, the page stays under 40,000 bytes, and the next page starts right after
  const big = await tool('databrain_search', { query: 'capzulu', limit: 200 });
  const bytes = Buffer.byteLength(big);
  assert(bytes <= 40000, `a page never goes past 40000 bytes (${bytes})`);
  const header = /Results 1-(\d+) of 100\./.exec(big);
  assert(header && Number(header[1]) < 100 && Number(header[1]) >= 20, `the page was cut before 100 hits, and still holds many (${header?.[0]})`);
  assert.equal(rankLines(big).length, Number(header[1]), 'the header names exactly the hits shown');
  const next = await tool('databrain_search', { query: 'capzulu', limit: 200, offset: Number(header[1]) });
  const nextFirst = /^\s*(\d+)\s+-?[0-9.]+\s/m.exec(next);
  assert.equal(Number(nextFirst?.[1]), Number(header[1]) + 1, `the next page starts at the hit after the last one shown:\n${next.slice(0, 200)}`);
  const seen = new Set(rankLines(big).map(line => line.trim().split(/\s+/)[2]));
  assert(!rankLines(next).some(line => seen.has(line.trim().split(/\s+/)[2])), 'no hit is on both pages');
  const titleLine = big.split('\n').find(line => /Very long title/.test(line) && line.includes(' · '));
  assert(titleLine && titleLine.split(' · ')[0].trim().length <= 80, `a very long title is cut to 80 characters:\n${titleLine}`);
  const spec = (await ask('tools/list', {})).result.tools.find(candidate => candidate.name === 'databrain_search');
  assert(!/at most 8 per page/.test(spec.description) && spec.inputSchema.properties.limit.maximum === 200 && spec.inputSchema.properties.limit.default === 100, 'the tool spec tells the new page size');
  console.log('PASS: pages hold up to 100 hits (200 on request); the top 5 have a full excerpt, the rest one short line; a page never passes 40,000 bytes and the next page continues after the last hit shown.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
