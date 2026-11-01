// 0.1.44. A file whose size and mtime match the baseline but whose ctime moved (iCloud sync, a rewrite with the same bytes, chmod) was TOUCHED, not edited:
// the index is still current. A real edit (different size or mtime, or same size and mtime with different bytes) still counts as changed, and a cloud-only
// file is never opened to find out.
// Package under test = the folder holding DATABRAIN_SERVER (default: the source tree). Part 1 runs freshness-core.mjs alone, part 2 a real server in a fake HOME.
// Mutants (FRESHNESS_MUTANT, applied to a COPY of the package under test): no-digest-compare | no-dataless-skip | touch-is-change.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let server = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
if (process.env.FRESHNESS_MUTANT) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-fresh-mutant-'));
  await fs.cp(path.resolve(path.dirname(server), '..', '..'), temp, { recursive: true });
  const core = path.join(temp, 'setup', 'mcp', 'freshness-core.mjs');
  let s = await fs.readFile(core, 'utf8'); const before = s;
  if (process.env.FRESHNESS_MUTANT === 'no-digest-compare') s = s.replace("return (await contentDigest(file, roots, actual)) === was[5];", 'return true;');
  if (process.env.FRESHNESS_MUTANT === 'no-dataless-skip') s = s.replace("  if (cloudOnly.has(file)) return true;", '');
  if (process.env.FRESHNESS_MUTANT === 'touch-is-change') s = s.replace("  if (was[2] !== actual[2] || was[3] !== actual[3]) return false;", '  return false;');
  assert.notEqual(s, before, `mutant ${process.env.FRESHNESS_MUTANT} applied (only the 0.1.44 package has the code to mutate)`);
  await fs.writeFile(core, s);
  server = path.join(temp, 'setup', 'mcp', 'server.mjs');
}
process.env.DATABRAIN_SERVER = server;   // the harness reads it at import time
const engineDir = path.dirname(server);
const { captureFreshnessBaseline, checkFreshness, changedSinceBaseline } = await import(pathToFileURL(path.join(engineDir, 'freshness-core.mjs')));
const harness = await import('./mcp-harness-0138.mjs');
const touch = (...args) => { const out = spawnSync('/usr/bin/touch', args); assert.equal(out.status, 0, `touch ${args.join(' ')}: ${out.stderr}`); };
// Rewrite with the given bytes, then give the file back its old mtime to the nanosecond (a ctime-only change when the bytes are the same).
const rewriteKeepingMtime = async (file, bytes) => {
  const ref = `${file}.ref`; await fs.writeFile(ref, ''); touch('-r', file, ref);
  await fs.writeFile(file, bytes); touch('-r', ref, file); await fs.rm(ref);
};
const stat = file => fs.lstat(file, { bigint: true });

// ---------- part 1: the freshness core on its own ----------
if (process.env.FRESHNESS_PART !== 'server') {   // FRESHNESS_PART=server runs part 2 only (the real 0.1.43 package has no digests, so part 1 cannot apply to it)
const temp1 = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-fresh-core-')));
const root = path.join(temp1, 'selected'); await fs.mkdir(root);
const names = ['touched-chmod', 'touched-rewrite', 'edited-same-size', 'edited-size', 'cloud-stub', 'legacy-touched'];
const files = Object.fromEntries(names.map(name => [name, path.join(root, `${name}.md`)]));
for (const name of names) await fs.writeFile(files[name], `# ${name}\nsynthetic text of ${name}, original.\n`);
const indexText = Object.values(files).map(file => `${file}\tT\t-\t-`).join('\n') + '\n';
const live = Object.values(files);
const baseline = await captureFreshnessBaseline({ roots: [root], indexText });
assert(baseline.split('\n').filter(line => line && !line.startsWith('#')).every(line => /\t[0-9a-f]{64}$/.test(line)), `every local file has a content digest in its row:\n${baseline}`);
const check = (text, extra = {}) => checkFreshness({ roots: [root], indexText, livePaths: live, baselineText: text, ...extra });
assert.equal((await check(baseline)).stale, false, 'untouched: current');
// A baseline written by 0.1.43 has five columns and no digest.
const legacy = baseline.split('\n').map(line => line.startsWith('#') || !line ? line : line.split('\t').slice(0, 6).join('\t')).join('\n');
const lines = Object.fromEntries(baseline.split('\n').filter(line => line && !line.startsWith('#')).map(line => [decodeURIComponent(line.split('\t')[0]), line]));
assert.equal((await check(legacy)).stale, false, 'a 0.1.43-style baseline is fine while nothing moved');

const before = Object.fromEntries(await Promise.all(names.map(async name => [name, await stat(files[name])])));
await fs.chmod(files['touched-chmod'], 0o600);                                                         // ctime only
await rewriteKeepingMtime(files['touched-rewrite'], `# touched-rewrite\nsynthetic text of touched-rewrite, original.\n`);   // same bytes, same mtime, new ctime
await rewriteKeepingMtime(files['edited-same-size'], `# edited-same-size\nsynthetic text of edited-same-size, ORIGINAL.\n`);   // same size and mtime, DIFFERENT bytes
await fs.writeFile(files['edited-size'], '# edited-size\nmuch longer replacement text.\n');             // size and mtime differ
await fs.chmod(files['cloud-stub'], 0o000);                                                            // unreadable: any open would fail; ctime moved, size and mtime kept
await rewriteKeepingMtime(files['legacy-touched'], `# legacy-touched\nsynthetic text of legacy-touched, original.\n`);
const after = Object.fromEntries(await Promise.all(names.map(async name => [name, await stat(files[name])])));
for (const name of ['touched-chmod', 'touched-rewrite', 'edited-same-size', 'cloud-stub', 'legacy-touched']) {
  assert.equal(after[name].mtimeNs, before[name].mtimeNs, `precondition: ${name} kept its mtime to the nanosecond`);
  assert.equal(after[name].size, before[name].size, `precondition: ${name} kept its size`);
  assert.notEqual(after[name].ctimeNs, before[name].ctimeNs, `precondition: ${name} has a new ctime`);
}
const result = await check(baseline, { datalessAmong: all => new Set(all.filter(file => file === files['cloud-stub'])) });
assert.deepEqual(result.changed, [files['edited-same-size'], files['edited-size']].sort(), `only the real edits are changed (touched and cloud-only files are not):\n${JSON.stringify(result)}`);
const withoutCloud = await check(baseline);
assert(withoutCloud.changed.includes(files['cloud-stub']), 'precondition: without the cloud flag the unreadable stub would be changed (so the flag is what saves it)');
const legacyResult = await check(legacy, { datalessAmong: all => new Set(all.filter(file => file === files['cloud-stub'])) });
assert(legacyResult.changed.includes(files['legacy-touched']) && legacyResult.changed.includes(files['touched-chmod']), 'a touched file with NO digest in its row cannot be proven the same, so it is changed once (the refresh then records digests)');
const seen = await changedSinceBaseline({ files: live, roots: [root], baselineText: baseline, datalessAmong: all => new Set(all.filter(file => file === files['cloud-stub'])) });
assert.equal(seen.get(files['touched-rewrite']), 'same'); assert.equal(seen.get(files['edited-same-size']), 'changed'); assert.equal(seen.get(files['cloud-stub']), 'same');
// A new baseline keeps the digest of a file that did not move and never opens a cloud-only one.
const next = await captureFreshnessBaseline({ roots: [root], indexText, previousText: baseline, datalessAmong: all => new Set(all.filter(file => file === files['cloud-stub'])) });
const nextLines = Object.fromEntries(next.split('\n').filter(line => line && !line.startsWith('#')).map(line => [decodeURIComponent(line.split('\t')[0]), line]));
assert.equal(nextLines[files['cloud-stub']].split('\t')[6], '-', 'a cloud-only file gets no digest and was not opened');
assert.equal(nextLines[files['edited-same-size']].split('\t')[6] === lines[files['edited-same-size']].split('\t')[6], false, 'the digest of the edited file is new');
console.log('PASS core: touch-only is not a change, real edits are, cloud-only files are never opened');
await fs.chmod(files['cloud-stub'], 0o600); await fs.rm(temp1, { recursive: true, force: true });
}
if (process.env.FRESHNESS_PART === 'core') process.exit(0);

// ---------- part 2: a real server, the real health report ----------
const { temp, home, docs, dataHome, statePath } = await harness.fakeHome('fresh-touch');
const { sleep, until } = harness;
const note = name => path.join(docs, `${name}.md`);
const bodies = { stable: '# Stable\nfresholdmark stable text one.\n', tomato: '# Tomato\ntouchedrewritemarker tomatoes stay.\n', edit: '# Edit\nfresholdmark edited text here.\n', stub: '# Stub\nstubnotemarker stays local text.\n' };
for (const [name, body] of Object.entries(bodies)) await fs.writeFile(note(name), body);
const dataless = path.join(temp, 'dataless.list'); await fs.writeFile(dataless, '');
const s = harness.startServer({ home, roots: [docs], env: { DATABRAIN_FRESHNESS_CHECK_MS: '100', NB_TEST_DATALESS_LIST: dataless } });
const quiet = async () => until(async () => { const t = await s.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'idle', 240000);
const timing = async () => fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '');
try {
  await harness.initialize(s); await harness.setupToReady(s); await quiet(); await sleep(1500);
  const h0 = await s.tool('databrain_health');
  assert(/Source freshness: current\./.test(h0), `precondition: current after setup:\n${h0}`);
  const jobsBefore = (await timing()).split('\n').filter(line => /\tjob-start\t/.test(line)).length;
  // touch-only: ctime moves, bytes and mtime do not
  const keepStat = await stat(note('tomato'));
  await fs.chmod(note('stable'), 0o600);
  await rewriteKeepingMtime(note('tomato'), bodies.tomato);
  await fs.chmod(note('stub'), 0o000); await fs.writeFile(dataless, `${await fs.realpath(note('stub'))}\n`);
  assert.notEqual((await stat(note('tomato'))).ctimeNs, keepStat.ctimeNs, 'precondition: new ctime');
  await sleep(600);
  const found = await s.tool('databrain_search', { query: 'touchedrewritemarker' });   // runs the on-use freshness check
  await sleep(1500);
  const h1 = await s.tool('databrain_health');
  const audit = await s.tool('databrain_verify_install');
  const line = audit.split('\n').find(l => /Selected-source health/.test(l)) || '';
  assert(/Source freshness: current\./.test(h1), `touch-only changes leave the health report at current:\n${h1}`);
  assert(/freshness current/.test(line), `and the install audit says freshness is current:\n${line}`);
  assert(!/Freshness: \d+ files? changed/.test(found), `and a search does not announce changed files:\n${found}`);
  const jobsAfter = (await timing()).split('\n').filter(line => /\tjob-start\t/.test(line)).length;
  assert.equal(jobsAfter, jobsBefore, 'and no refresh was started for them');
  // a real edit with the same size and mtime is still found and re-indexed
  await rewriteKeepingMtime(note('edit'), '# Edit\nfreshnewmark edited text here.\n');
  assert.equal((await fs.stat(note('edit'))).size, Buffer.byteLength(bodies.edit), 'precondition: same size');
  await sleep(600);
  await until(async () => { await s.tool('databrain_search', { query: 'freshnewmark' }); const t = await s.tool('databrain_search', { query: 'freshnewmark' }); return /edit\.md/.test(t) && !/Freshness:/.test(t); }, 'the same-size same-mtime edit is re-indexed', 120000);
  console.log('PASS server: touch-only left freshness current, a same-size same-mtime edit was re-indexed');
} finally {
  await fs.chmod(note('stub'), 0o600).catch(() => {});
  s.child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
