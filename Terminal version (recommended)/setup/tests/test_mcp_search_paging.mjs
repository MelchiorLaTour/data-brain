// databrain_search pages through its results (0.1.30). It used to stop at 8; the terminal gives 20 and more. Each page says which results it shows and
// how many there are ("Results 9-16 of 20."), `offset` reaches the rest. 0.1.31: no 60-result cap, the count is exact ("Results 1-8 of 70."), and identical copies
// do not leave short pages (the page is filled from further down the ranking). Later in 0.1.31 a page holds up to 100 hits by default (200 on request,
// 40,000 bytes at most): a topic of 20 or 70 notes is ONE page by default, and `limit: 8` still gives small pages.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-paging-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// 20 notes share "pagingsmall", 70 share "pagingbig"; each also has its own words, so no two are copies of each other.
// "pagingdup": 12 identical files and 20 different ones.
for (let i = 0; i < 20; i++) await fs.writeFile(path.join(docs, `small-${String(i).padStart(2, '0')}.md`), `# Small ${i}\npagingsmall note number ${i} with its own detail ${'x'.repeat(i)}q${i}.\n`);
for (let i = 0; i < 70; i++) await fs.writeFile(path.join(docs, `big-${String(i).padStart(2, '0')}.md`), `# Big ${i}\npagingbig note number ${i} with its own detail ${'y'.repeat(i % 7)}r${i}.\n`);
for (let i = 0; i < 12; i++) await fs.writeFile(path.join(docs, `copy-${String(i).padStart(2, '0')}.md`), '# Copy\npagingdup the same words in every copy.\n');
for (let i = 0; i < 20; i++) await fs.writeFile(path.join(docs, `solo-${String(i).padStart(2, '0')}.md`), `# Solo ${i}\npagingdup note number ${i} with its own detail ${'z'.repeat(i)}s${i}.\n`);

let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result;
const tool = async (name, args = {}) => (await call(name, args))?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 180000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const hitPaths = text => [...text.matchAll(/^\s*\d+\s+-?[0-9.]+\s+(.+\.md)\s*$/gm)].map(match => match[1]);
const header = text => /^(Results \d+-\d+ of \d+( or more)?\.|No more results: .*)$/m.exec(text)?.[0];
const endOf = text => Number(/^Results \d+-(\d+) of/m.exec(text)?.[1]);

try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  await until(async () => (await tool('databrain_search', { query: 'pagingbig' })).includes('big-'), 'notes are searchable');
  await sleep(1500);

  // a small topic: 20 results in all, one default page, and walked 8 at a time
  const byDefault = await tool('databrain_search', { query: 'pagingsmall' });
  assert.equal(header(byDefault), 'Results 1-20 of 20.', `the default page says what it shows:\n${byDefault.slice(0, 600)}`);
  assert.equal(hitPaths(byDefault).length, 20, 'and shows all 20');
  const bigDefault = await tool('databrain_search', { query: 'pagingbig' });
  assert.equal(header(bigDefault), 'Results 1-70 of 70.', `70 notes still fit one default page (up to 100 hits):\n${bigDefault.slice(0, 300)}`);
  const pages = [];
  for (const [offset, expected, count] of [[0, 'Results 1-8 of 20.', 8], [8, 'Results 9-16 of 20.', 8], [16, 'Results 17-20 of 20.', 4]]) {
    const page = await tool('databrain_search', { query: 'pagingsmall', limit: 8, offset });
    assert.equal(header(page), expected, `page at offset ${offset}:\n${page.slice(0, 600)}`);
    assert.equal(hitPaths(page).length, count, `page at offset ${offset} shows ${count}`);
    pages.push(...hitPaths(page));
  }
  assert.equal(new Set(pages).size, 20, 'the three pages together are the 20 results, none repeated');
  assert(pages.every(file => /small-\d\d\.md$/.test(file)), 'and all of them are the small notes');
  assert.deepEqual(hitPaths(byDefault), pages, 'the default page lists the same results in the same order as the three small pages');
  const past = await tool('databrain_search', { query: 'pagingsmall', limit: 8, offset: 40 });
  assert.equal(header(past), 'No more results: there are 20 results in all.', `past the end:\n${past.slice(0, 400)}`);
  assert.equal(hitPaths(past).length, 0, 'and shows none');

  // a big topic: no cap, the count is exact, the last page is the last results
  const bigFirst = await tool('databrain_search', { query: 'pagingbig', limit: 8 });
  assert.equal(header(bigFirst), 'Results 1-8 of 70.', `a topic bigger than the old 60 depth:\n${bigFirst.slice(0, 500)}`);
  const bigLast = await tool('databrain_search', { query: 'pagingbig', limit: 8, offset: 64 });
  assert.equal(header(bigLast), 'Results 65-70 of 70.', `the last page:\n${bigLast.slice(0, 500)}`);
  assert.equal(hitPaths(bigLast).length, 6);
  const bigPast = await tool('databrain_search', { query: 'pagingbig', limit: 8, offset: 70 });
  assert.equal(header(bigPast), 'No more results: there are 70 results in all.', `past the last result:\n${bigPast.slice(0, 300)}`);
  const bigSeen = new Set();
  for (let offset = 0; offset < 70; offset += 8) for (const file of hitPaths(await tool('databrain_search', { query: 'pagingbig', limit: 8, offset }))) bigSeen.add(file);
  assert.equal(bigSeen.size, 70, 'walking all the pages reaches all 70 notes, none missed, none repeated');

  // identical copies: pages stay full, the walk reaches every different note
  const dupSeen = new Set(); let dupAt = 0; let dupPages = 0;
  while (true) {
    const page = await tool('databrain_search', { query: 'pagingdup', limit: 8, offset: dupAt });
    if (/^No more results/m.test(page)) break;
    assert(/^Results \d+-\d+ of 32\.$/m.test(page), `the count is of all 32 matches, copies included:\n${page.slice(0, 300)}`);
    const shown = hitPaths(page);
    dupPages += 1;
    if (endOf(page) < 32) assert.equal(shown.length, 8, `a page that is not the last one is full although copies sit among the top results (offset ${dupAt}):\n${page.slice(0, 900)}`);
    shown.forEach(file => dupSeen.add(file));
    assert(endOf(page) > dupAt, 'every page moves forward');
    dupAt = endOf(page);
    assert(dupPages < 20, 'the walk ends');
  }
  assert.equal([...dupSeen].filter(file => /solo-/.test(file)).length, 20, 'every different note was reached');
  assert(dupSeen.size < 32, 'copies were shown fewer times than they exist');

  // nothing found, a bad offset, and the tool's own description
  const none = await tool('databrain_search', { query: 'zzzznomatchzzzz' });
  assert(!header(none) && /found nothing/.test(none), `nothing found has no page line:\n${none.slice(0, 300)}`);
  const bad = await tool('databrain_search', { query: 'pagingsmall', offset: -1 });
  assert(/offset must be a whole number/.test(bad), `a negative offset is refused:\n${bad.slice(0, 200)}`);
  const spec = (await ask('tools/list', {})).result.tools.find(candidate => candidate.name === 'databrain_search');
  assert(spec.inputSchema.properties.offset, 'the tool has an offset');
  assert(/everything on a topic/.test(spec.description) && /offset/.test(spec.description), 'the description tells Claude to page when the user wants everything on a topic');
  assert(/everything on a topic[^.;]*, call databrain_search with limit 200/.test(spec.description), 'and to ask for limit 200 pages when the user wants everything on a topic');
  const abstainSpec = (await ask('tools/list', {})).result.tools.find(candidate => candidate.name === 'databrain_abstain_check');
  assert(/search again with other words the note may use instead \(synonyms, for example "sign-in" for "login"/.test(spec.description), 'databrain_search tells Claude to retry with synonyms (the note may use other words than the question)');
  assert(/and other words the note may use instead: synonyms, for example "sign-in" for "login"/.test(abstainSpec.description), 'and so does databrain_abstain_check, in its variant guidance');
  assert.equal(spec.inputSchema.properties.limit.default, 100, 'while the default page stays 100 hits (ordinary lookups do not pay for 200)');
  console.log('PASS: databrain_search pages its results with an exact count and no cap ("Results 1-8 of 70." ... "Results 65-70 of 70."), none repeated or missed; pages stay full with identical copies; past the end says so; nothing found has no page line; a bad offset is refused.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
