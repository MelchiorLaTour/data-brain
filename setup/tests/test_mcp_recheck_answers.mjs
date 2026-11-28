// Part 44 (ChatGPT): the first start after an update re-checks every file with the new privacy rules (571 s on a real brain, 2026-11-27).
// 1. Searches answer during the re-check, but only with hits whose indexed text passes the CURRENT rules at serve time; a file whose old
//    indexed text the new rules hold is never shown (here: a note whose indexed text holds a password, planted in the index as if older
//    rules had let it in).
// 2. Five servers started within a second make exactly ONE refresh job; the others answer while it runs.
// 3. Repair asked during the re-check says so, starts nothing and returns at once.
// Invented data, fake HOME. Usage: node test_mcp_recheck_answers.mjs
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, setupFromChat, sleep, startChatgpt, until } from './chatgpt-harness.mjs';

const NEW_RULES = '0.2.1-part40';
const { home, docs, dataHome, statePath } = await fakeHome('p44recheck');
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const logPath = path.join(dataHome, '.databrain', 'stage-timing.log');
const jobStarts = async () => (await fs.readFile(logPath, 'utf8').catch(() => '')).split('\n').filter(line => line.split('\t')[1] === 'refresh' && line.split('\t')[3] === 'job-start').length;

await fs.writeFile(path.join(docs, 'base.md'), '# Base\np44base garden notes.\n');
await fs.writeFile(path.join(docs, 'clean.md'), '# Allotment\np44clean tomatoes and beans along the fence.\n');
await fs.writeFile(path.join(docs, 'leak.md'), '# Router\np44leak the box in the hall.\n');
await fs.writeFile(path.join(docs, 'gone.md'), '# Shed\np44gone rakes and a wheelbarrow.\n');
await fs.writeFile(path.join(docs, 'throws.md'), '# Pond\np44throws frogs and lilies.\n');
let servers = [startChatgpt({ home })];
try {
  await servers[0].initialize();
  await setupFromChat(servers[0], [docs]);
  servers[0].child.kill('SIGTERM'); await sleep(800);

  // An index screened by older rules: the indexed text of leak.md now holds a password the current rules hold.
  const db = path.join(dataHome, 'moc', 'fts.db');
  execFileSync('/usr/bin/sqlite3', [db, "UPDATE notes SET body = body || ' Password: hunter2wifi' WHERE path LIKE '%leak.md';"]);
  assert.match(execFileSync('/usr/bin/sqlite3', [db, "SELECT body FROM notes WHERE path LIKE '%leak.md';"], { encoding: 'utf8' }), /hunter2wifi/, 'the planted index text is in place');
  await fs.writeFile(statePath, JSON.stringify({ ...(await state()), privacyRulesVersion: '0.1.38' }, null, 2));

  // 2. Five servers within a second (ChatGPT opened 7 in 2.5 minutes), each with a slow re-check.
  const before = await jobStarts();
  // Part 44b: failures injected per server (test hooks, ignored on a real home). A screen that cannot run must hide, never show.
  const hooks = [{}, { DATABRAIN_TEST_NO_INDEXED_BODY: 'gone.md' }, {}, { DATABRAIN_TEST_SCREEN_THROWS: 'throws.md' }, { DATABRAIN_TEST_NAME_SCREEN_FAILS: '1' }];
  servers = hooks.map(hook => startChatgpt({ home, env: { DATABRAIN_TEST_UPDATE_DELAY_MS: '20000', ...hook } }));
  await Promise.all(servers.map(server => server.initialize()));
  await sleep(4000);
  assert.notEqual((await state()).privacyRulesVersion, NEW_RULES, 'the re-check is still running');
  assert.equal(await jobStarts() - before, 1, `exactly one refresh job for five server starts:\n${await fs.readFile(logPath, 'utf8')}`);

  // 1. Answers during the re-check, from every server (the one doing the work and the ones that are not).
  for (const server of [servers[0], servers[1]]) {
    const clean = await server.tool('databrain_search', { query: 'p44clean' });
    assert(clean.includes('clean.md') && clean.includes('tomatoes'), `a file that passes the current rules answers during the re-check:\n${clean}`);
    assert.match(clean, /re-checking files after an update/, 'one fact line says a re-check is running');
    const leak = await server.tool('databrain_search', { query: 'p44leak' });
    assert(!leak.includes('leak.md') && !leak.includes('hunter2wifi') && !leak.includes('Router'), `a hit the current rules hold is not shown, not even its name:\n${leak}`);
    const abstain = await server.tool('databrain_abstain_check', { queries: ['p44leak', 'p44leak hall'] });
    assert(!abstain.includes('leak.md') && !abstain.includes('hunter2wifi'), `the abstain check does not name it either:\n${abstain}`);
    const read = await server.tool('databrain_read', { path: path.join(docs, 'clean.md') });
    assert(read.includes('tomatoes'), `a clean file reads during the re-check:\n${read}`);
  }

  // Part 44b: the header counts only what is shown (one clean hit, one withheld), not the engine's total.
  const both = await servers[0].tool('databrain_search', { query: 'p44clean p44leak' });
  assert.match(both, /^.*\b1 result shown that passed the updated privacy rules\./m, `the header counts only shown results:\n${both}`);
  assert(!/Results \d+-\d+ of/.test(both) && !both.includes('leak.md'), `no engine total and no withheld hit in the header or list:\n${both}`);

  // Part 44b, fail-closed: a hit whose indexed body is missing (server 1) or whose screen throws (server 3) is not shown; a name screen that
  // fails (server 4) hides everything and says so.
  const hidden = [[servers[1], 'p44gone', 'gone.md', 'wheelbarrow'], [servers[3], 'p44throws', 'throws.md', 'lilies'], [servers[4], 'p44clean', 'clean.md', 'tomatoes']];
  for (const [server, word, file, text] of hidden) {
    const found = await server.tool('databrain_search', { query: word });
    assert(!found.includes(file) && !found.includes(text), `search: a hit that could not be checked is not shown (${file}):\n${found}`);
    assert.match(found, /could not check one or more results against the updated privacy rules/, `search says results could not be checked (${file}):\n${found}`);
    const checked = await server.tool('databrain_abstain_check', { queries: [word, `${word} notes`] });
    assert(!checked.includes(file) && !checked.includes(text), `abstain: a hit that could not be checked is not named (${file}):\n${checked}`);
    assert.match(checked, /could not check one or more results against the updated privacy rules/, `abstain says results could not be checked (${file}):\n${checked}`);
  }
  const otherOk = await servers[3].tool('databrain_search', { query: 'p44clean' });
  assert(otherOk.includes('clean.md'), `only the file whose screen failed is hidden:\n${otherOk}`);

  // 3. Repair during the re-check: a fact, no new work, no long wait.
  const startsBeforeRepair = await jobStarts();
  const t0 = Date.now();
  const repair = await servers[2].tool('databrain_repair', {});
  assert(Date.now() - t0 < 5000, `repair returns at once during the re-check (${Date.now() - t0} ms)`);
  assert.match(repair, /re-checking files after an update/, `repair says the re-check is running:\n${repair}`);
  assert.match(repair, /no repair is needed/i, `repair says it is not needed:\n${repair}`);
  assert.equal(await jobStarts(), startsBeforeRepair, 'repair started no job');

  await until(async () => (await state()).privacyRulesVersion === NEW_RULES, 'the re-check finished', 300000);
  assert.equal(await jobStarts() - before, 1, 'still exactly one refresh job after the re-check');
  const after = await servers[1].tool('databrain_search', { query: 'p44clean' });
  assert(after.includes('clean.md') && !after.includes('re-checking files after an update'), `after the re-check: normal answers, no re-check line:\n${after}`);
  console.log('PASS: during the post-update re-check searches answer with hits that pass the current rules only; five servers start one refresh; repair says no repair is needed and starts nothing');
} finally {
  for (const server of servers) server.child.kill('SIGTERM');
  await sleep(500);
}
