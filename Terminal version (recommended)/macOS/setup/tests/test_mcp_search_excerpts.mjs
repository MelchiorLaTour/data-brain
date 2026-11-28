// databrain_search shows a short excerpt around the matched words for each hit (0.1.31), so "everything on X" can be covered from the excerpts and
// only the notes that matter are opened in full. An excerpt is one line of about 200 characters at most, comes from the indexed text only, and is
// left out for a hit that was edited after it was indexed (its indexed text may be old, or may now be private) and for a file the user excluded.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-excerpt-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const filler = word => Array.from({ length: 400 }, (_, i) => `${word}${i % 37}`).join(' ');
for (let i = 0; i < 5; i++) await fs.writeFile(path.join(docs, `exc-${i}.md`), `# Excerpt note ${i}\n${filler('alpha')}\nthe excerptzulu detail of note ${i} is ownmark${i} right here.\n${filler('omega')}\n`);
const longWords = Array.from({ length: 60 }, (_, i) => `veryverylongword${'x'.repeat(40)}${i}`).join(' ');
await fs.writeFile(path.join(docs, 'exc-longwords.md'), `# Long words\n${longWords} excerptzulu ${longWords}\n`);
await fs.writeFile(path.join(docs, 'exc-edit.md'), `# Edited note\n${filler('alpha')}\nthe excerptzulu detail was oldsecretwords before the edit.\n${filler('omega')}\n`);
await fs.writeFile(path.join(docs, 'exc-excluded.md'), `# Excluded note\n${filler('alpha')}\nthe excerptzulu detail of the excluded note is hiddenbody.\n${filler('omega')}\n`);

let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 180000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
// hit blocks: the rank line (it holds the path), then what follows it up to the next hit. The first 5 hits of a page carry "From your files:" and an
// `excerpt:` line; the rest are one compact line "title · date · excerpt" (item 9), so a hit's excerpt is read from whichever form it has.
const blocks = text => text.split('\n').reduce((all, line) => { if (/^\s*\d+\s+-?[0-9.]+\s+\S/.test(line)) all.push([line]); else if (all.length && !/^From your files:/.test(line)) all.at(-1).push(line); return all; }, []);
const blockOf = (text, name) => blocks(text).find(block => block[0].includes(name));
const compactOf = block => { for (const line of block.slice(1)) { const m = /^\s+.*? · \d{4}-\d\d-\d\d(?: · (.*))?$/.exec(line); if (m) return m[1]; } return undefined; };
const isCompact = block => !block.some(line => /^\s+excerpt: /.test(line)) && block.some(line => / · \d{4}-\d\d-\d\d/.test(line));
const excerptOf = block => block?.find(line => /^\s+excerpt: /.test(line)) ?? compactOf(block ?? []);

try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => (await tool('databrain_search', { query: 'excerptzulu', limit: 8 })).includes('exc-excluded'), 'notes are searchable');
  await sleep(1500);

  // the files the user excluded after they were indexed, and one edited after: both change only on disk / in the privacy list
  const privacy = spawnSync('/usr/bin/find', [temp, '-name', 'privacy.tsv'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
  assert(privacy, 'the privacy list exists');
  await fs.appendFile(privacy, `excluded\t${path.join(docs, 'exc-excluded.md')}\tnot for the test\n`);
  await sleep(1100);
  await fs.writeFile(path.join(docs, 'exc-edit.md'), '# Edited note\nthe excerptzulu detail is now newwords after the edit.\n');

  const found = await tool('databrain_search', { query: 'excerptzulu', limit: 8 });
  for (let i = 0; i < 5; i++) {
    const block = blockOf(found, `exc-${i}.md`);
    const line = excerptOf(block);
    assert(line, `hit ${i} has an excerpt line:\n${found.slice(0, 1500)}`);
    assert(line.includes('excerptzulu'), `the excerpt is around the matched word:\n${line}`);
    if (!isCompact(block)) assert(line.includes(`ownmark${i}`), `and it is this note's own text, not another hit's:\n${line}`);   // a compact line keeps only 100 characters
    assert(line.length <= 260, `and short (${line.length} characters):\n${line}`);
    assert(block.filter(l => /excerpt: /.test(l)).length <= 1, 'one excerpt per hit');
  }
  const longLine = excerptOf(blockOf(found, 'exc-longwords.md'));
  assert(longLine && longLine.length <= 260, `an excerpt from very long words is still cut to about 200 characters (${longLine?.length}):\n${longLine}`);
  const edited = blockOf(found, 'exc-edit.md');
  assert(edited?.some(line => /edited since it was indexed/.test(line)), `the edited hit is flagged:\n${found.slice(0, 1500)}`);
  assert(!excerptOf(edited), `an edited hit shows no excerpt:\n${edited.join('\n')}`);
  assert(!found.includes('oldsecretwords') && !found.includes('newwords'), 'neither its old nor its new text is shown');
  const excluded = blockOf(found, 'exc-excluded.md');
  assert(excluded, 'an excluded file that is still in the index is still listed as a lead (as before)');
  assert(!excerptOf(excluded) && !found.includes('hiddenbody'), `a file the user excluded shows no excerpt:\n${excluded?.join('\n')}`);

  // a page smaller than the list: each hit keeps ITS OWN excerpt
  for (let offset = 0; offset < 8; offset++) {   // one hit per page: the rows read after it must not touch its excerpt
    const one = await tool('databrain_search', { query: 'excerptzulu', limit: 1, offset });
    const own = /exc-(\d)\.md/.exec(one)?.[1];
    if (own !== undefined) assert(excerptOf(blocks(one)[0])?.includes(`ownmark${own}`), `the excerpt under exc-${own}.md is its own, not a later row's (offset ${offset}):\n${one.slice(0, 700)}`);
  }
  // page 2 carries excerpts too, and a search with no match is unchanged
  const second = await tool('databrain_search', { query: 'excerptzulu', limit: 2, offset: 2 });
  assert(blocks(second).length >= 1 && blocks(second).every(block => block === blockOf(second, 'exc-') ? true : true), 'a later page lists hits');
  assert(blocks(second).filter(block => !block.some(l => /edited since|exc-excluded|exc-edit/.test(l))).every(block => excerptOf(block)), `hits on a later page have their excerpt:\n${second.slice(0, 800)}`);
  const none = await tool('databrain_search', { query: 'zzzznomatchzzzz' });
  assert(/found nothing/.test(none) && !/excerpt:/.test(none), `nothing found has no excerpt:\n${none.slice(0, 300)}`);
  const spec = (await ask('tools/list', {})).result.tools.find(candidate => candidate.name === 'databrain_search');
  assert(/excerpt/.test(spec.description) && !/at most 8 per page.*60/.test(spec.description), 'the description tells Claude to use the excerpts to decide which hits to open');
  console.log('PASS: each databrain_search hit has one short excerpt around the matched words; none for an edited hit or an excluded file; later pages have them; nothing found has none; the description mentions them.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
