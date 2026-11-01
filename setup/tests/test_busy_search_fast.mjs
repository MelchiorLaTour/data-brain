// 0.1.45 item B. Questions (search, read, abstain_check) must not wait for a running index job and must not spend seconds screening a long hit list one process at a time.
// 0.1.44 on a 6,000-note brain: every question waited the full 15 s while a job ran, and a 100-hit search spent about 12 s in sequential privacy-screen processes.
// Phase 1: a 150-note brain, one search whose 100 hits are all screened: must come back inside LIMIT_MS, nothing withheld.
// Phase 2: a refresh is running (slowed by DATABRAIN_TEST_UPDATE_DELAY_MS): every question returns inside LIMIT_MS with the existing "New changes are being added" sentence.
// Phase 3: when the job is over a question sees the new text (the update was not lost). That a note held by its content is still never shown by search, and shown again after approval, is test_search_screen_approval.mjs.
// Package under test = the folder holding DATABRAIN_SERVER (default: the source tree). Mutants (BUSY_MUTANT, applied to a COPY): old-wait | sequential-screen.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let server = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
if (process.env.BUSY_MUTANT) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-busy-mutant-'));
  await fs.cp(path.resolve(path.dirname(server), '..', '..'), temp, { recursive: true });
  server = path.join(temp, 'setup', 'mcp', 'server.mjs');
  let s = await fs.readFile(server, 'utf8'); const before = s;
  if (process.env.BUSY_MUTANT === 'old-wait') s = s.replace("  if ([...activeJobs.values()].some(job => ['refresh', 'app check', 'note write'].includes(job.kind) && job.status === 'running')) return `\\n\\n${CHANGES_BEING_ADDED}`;\n  if (freshenInFlight) return waitFor(freshenInFlight);", "  if (freshenInFlight) return waitFor(freshenInFlight);\n  if ([...activeJobs.values()].some(job => ['refresh', 'app check', 'note write'].includes(job.kind) && job.status === 'running')) return `\\n\\n${CHANGES_BEING_ADDED}`;").replace("|| 1500;\nconst statusWaitMs", "|| 15000;\nconst statusWaitMs");
  if (process.env.BUSY_MUTANT === 'sequential-screen') s = s.replace('const SCREEN_PARALLEL = 8;', 'const SCREEN_PARALLEL = 1;').replace("  const known = screenMemo.get(key);\n  if (known) return known;\n", '');
  assert.notEqual(s, before, `mutant ${process.env.BUSY_MUTANT} applied (only the 0.1.45 package has the code to mutate)`);
  await fs.writeFile(server, s);
}
process.env.DATABRAIN_SERVER = server;   // the harness reads it at import time
const harness = await import('./mcp-harness-0138.mjs');
const { sleep, until } = harness;
const LIMIT_MS = Number(process.env.BUSY_LIMIT_MS) || 5000;

const { temp, home, docs, dataHome, statePath } = await harness.fakeHome('busy-search');
const note = i => path.join(docs, `n${String(i).padStart(3, '0')}.md`);
for (let i = 0; i < 150; i++) await fs.writeFile(note(i), `# Note ${i}\nbusysharedword uniquebusy${i} tomatoes need staking in June. ${'Plain synthetic filler text about plans and lists. '.repeat(6)}\n`);
const s = harness.startServer({ home, roots: [docs], env: { DATABRAIN_FRESHNESS_CHECK_MS: '100', DATABRAIN_TEST_UPDATE_DELAY_MS: '12000' } });
const timed = async (label, fn) => { const t = Date.now(); const text = await fn(); const ms = Date.now() - t; console.log(`${label}: ${ms} ms`); return { text, ms }; };
try {
  await harness.initialize(s); await harness.setupToReady(s);
  await until(async () => /Stage: ready\./.test(await s.tool('databrain_setup_status')) && !/Running now/.test(await s.tool('databrain_setup_status')), 'idle', 240000);
  await sleep(1500);
  // phase 1
  const wide = await timed('phase 1: search with 100 hits', () => s.tool('databrain_search', { query: 'busysharedword' }));
  const shown = (wide.text.match(/From your files: /g) || []).length;
  assert(shown >= 3, `the search shows its hits (${shown} shown; a page is filled by size, the other hits are screened too):\n${wide.text.slice(0, 600)}`);
  assert(!/withheld|could not be screened|privacy screen failed/i.test(wide.text), `no hit is withheld or unscreened:\n${wide.text.slice(0, 600)}`);
  assert(wide.ms <= LIMIT_MS, `a 100-hit search takes ${wide.ms} ms, over ${LIMIT_MS} ms`);
  // phase 2: an edit makes the next check stale; the refresh it starts is slowed, so it is running for the next 12 s
  await fs.writeFile(note(7), '# Note 7\nbusysharedword uniquebusy7 edited so a refresh is due, laterword.\n');
  await sleep(300);
  const first = await timed('phase 2: first question (starts the refresh)', () => s.tool('databrain_search', { query: 'uniquebusy3' }));
  assert(first.ms <= LIMIT_MS, `the question that starts the refresh answers inside ${LIMIT_MS} ms (took ${first.ms})`);
  assert(/Freshness:|New changes are being added/.test(first.text), `and says the index is being updated:\n${first.text.slice(0, 400)}`);
  const during = [];
  for (const [what, run] of [
    ['search', () => s.tool('databrain_search', { query: 'busysharedword' })],
    ['abstain_check', () => s.tool('databrain_abstain_check', { queries: ['uniquebusy5'] })],
    ['read', () => s.tool('databrain_read', { path: note(9) })],
    ['search', () => s.tool('databrain_search', { query: 'uniquebusy11' })],
  ]) { const r = await timed(`phase 2: ${what} while the refresh runs`, run); during.push(r); assert(r.ms <= LIMIT_MS, `${what} while a refresh runs took ${r.ms} ms, over ${LIMIT_MS} ms`); }
  assert(during.some(r => /New changes are being added|Freshness:/.test(r.text)), 'while the refresh runs the answers say the update is in progress');
  // phase 3
  await until(async () => /Stage: ready\./.test(await s.tool('databrain_setup_status')) && !/Running now/.test(await s.tool('databrain_setup_status')), 'refresh finished', 240000);
  await sleep(500);
  const later = await timed('phase 3: search for the edited text', () => s.tool('databrain_search', { query: 'laterword' }));
  assert(/n007\.md/.test(later.text), `after the update the edit is found:\n${later.text.slice(0, 400)}`);
  console.log('PASS busy search: questions answer inside ' + LIMIT_MS + ' ms while a refresh runs and with a 100-hit list');
} finally {
  s.child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
