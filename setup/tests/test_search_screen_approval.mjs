// 0.1.45 rebuild. The privacy screen of SEARCH hits (screenTextAsync) looks at the indexed text of each hit with the current rules.
// Part A (search-path content screen): a note whose indexed text holds the email + short token shape is withheld from a search (its text never appears; the hit line still names the file, as since 0.1.38).
//   The index is made to hold that text the way an older rules version would have left it (the indexed body is rewritten in fts.db after a normal setup).
//   Mutant SCREEN_MUTANT=always-ok (screenTextAsync always says ok): part A must FAIL.
// Part B (approval in the SAME server session): after the user approves that held file in the chat, a search shows it again. 0.1.45's first build remembered
//   the 'held' verdict per file and text, so the approved file stayed hidden from search until the server restarted. Mutant SCREEN_MUTANT=remember-held: part B must FAIL.
// Package under test = the folder holding DATABRAIN_SERVER (default: the source tree).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let server = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
if (process.env.SCREEN_MUTANT) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-screen-mutant-'));
  await fs.cp(path.resolve(path.dirname(server), '..', '..'), temp, { recursive: true });
  server = path.join(temp, 'setup', 'mcp', 'server.mjs');
  let s = await fs.readFile(server, 'utf8'); const before = s;
  if (process.env.SCREEN_MUTANT === 'always-ok') s = s.replace('async function screenTextAsync(file, text, nameAllowed) {\n', 'async function screenTextAsync(file, text, nameAllowed) {\n  return { ok: true };\n');
  if (process.env.SCREEN_MUTANT === 'remember-held') s = s.replace('  if (result.ok) {', '  {');
  assert.notEqual(s, before, `mutant ${process.env.SCREEN_MUTANT} applied (only a package with the 0.1.45 memo has the code to mutate)`);
  await fs.writeFile(server, s);
}
process.env.DATABRAIN_SERVER = server;   // the harness reads it at import time
const harness = await import('./mcp-harness-0138.mjs');
const { sleep, until } = harness;
const sql = (db, statement) => { const out = spawnSync('/usr/bin/sqlite3', [db, statement], { encoding: 'utf8' }); assert.equal(out.status, 0, `sqlite3: ${out.stderr}`); return out.stdout.trim(); };

const { temp, home, docs, dataHome } = await harness.fakeHome('search-approval');
await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\nscreenplainmarker tomatoes need staking in June.\n');
await fs.writeFile(path.join(docs, 'college-mail.md'), '# College mail\nscreenprivatemarker ordinary words here.\n');
const s = harness.startServer({ home, roots: [docs], env: { DATABRAIN_FRESHNESS_CHECK_MS: '100' } });
const idle = async () => until(async () => { const t = await s.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'idle', 240000);
const db = path.join(dataHome, 'moc', 'fts.db');
const leaksText = text => text.includes('sample.person') || text.includes('note to self') || text.includes('c014d1');   // the hit line still names the file (known, see REPORT-0.1.42); the TEXT must never show
try {
  await harness.initialize(s); await harness.setupToReady(s); await idle(); await sleep(1500);
  const plain = await s.tool('databrain_search', { query: 'screenplainmarker' });
  assert(plain.includes('plain.md'), `precondition: an ordinary note is found:\n${plain}`);
  assert(sql(db, "SELECT count(*) FROM notes WHERE path LIKE '%college-mail%'") !== '0', 'precondition: the note is in the search index');
  // The index now holds, for this note, text the current rules hold (what an older rules version would have indexed).
  const privateBody = '# College mail\nscreenprivatemarker ordinary words here.\n\nsample.person@example.edu\n\nnote to self\nc014d1\n';
  const hex = Buffer.from(privateBody).toString('hex');
  const poison = () => sql(db, `UPDATE notes SET body = CAST(x'${hex}' AS TEXT) WHERE path LIKE '%college-mail%'; SELECT changes();`);
  assert.equal(poison(), '1', 'precondition: one indexed section rewritten');

  // Part A: withheld from search.
  const first = await s.tool('databrain_search', { query: 'screenprivatemarker' });
  console.log('=== SEARCH, content held ===\n' + first.slice(0, 500) + '\n=== END ===');
  assert(!leaksText(first), `Part A: a note whose indexed text is private is withheld from search (its text never shows):\n${first}`);
  assert(/Privacy screen withheld/.test(first), `Part A: and the answer says an excerpt was withheld:\n${first}`);
  const list = await s.tool('databrain_privacy', { action: 'list' });
  assert(/college-mail\.md/.test(list), `Part A: and the screen recorded it as held for the user's review:\n${list}`);

  // Part B: the user approves it in the chat; the SAME server session must show it again.
  const decided = await s.tool('databrain_privacy', { action: 'decide', keep: ['college-mail.md'] });
  assert(/1 allowed/.test(decided), `precondition: the approval was recorded:\n${decided}`);
  await idle(); await sleep(1500);
  poison();   // whatever the refresh after the approval did, the indexed text is the same private-looking text as before
  const after = await s.tool('databrain_search', { query: 'screenprivatemarker' });
  assert(/ordinary words here/.test(after) && !/Privacy screen withheld/.test(after), `Part B: after the user approves a held file, a search in the same session shows its text again:\n${after}`);
  console.log('PASS search screen: private indexed text is withheld, and an approved file is shown again in the same session');
} finally {
  s.child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
