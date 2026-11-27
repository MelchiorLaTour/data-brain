// 0.1.45 item A. A file that was cloud-only when the baseline was taken (digest '-') and is local now with the SAME size and mtime was only downloaded:
// freshness stays current. A changed mtime or size is still an edit. A 0.1.43-style row (no digest column) is changed once. A cloud-only file is never opened.
// Package under test = the folder holding DATABRAIN_SERVER (default: the source tree). Part 1 = freshness-core alone, part 2 = a real server in a fake HOME.
// Mutant (CLOUD_MUTANT, applied to a COPY of the package): old-rule (the 0.1.44 rule: no digest = changed).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
let server = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
if (process.env.CLOUD_MUTANT) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloud-mutant-'));
  await fs.cp(path.resolve(path.dirname(server), '..', '..'), temp, { recursive: true });
  const core = path.join(temp, 'setup', 'mcp', 'freshness-core.mjs');
  let s = await fs.readFile(core, 'utf8'); const before = s;
  if (process.env.CLOUD_MUTANT === 'old-rule') s = s.replace("  if (was[5] === '-') return true;", "  if (was[5] === '-') return false;");
  assert.notEqual(s, before, 'mutant applied (only the 0.1.45 package has the code to mutate)');
  await fs.writeFile(core, s);
  server = path.join(temp, 'setup', 'mcp', 'server.mjs');
}
process.env.DATABRAIN_SERVER = server;   // the harness reads it at import time
const { captureFreshnessBaseline, checkFreshness } = await import(pathToFileURL(path.join(path.dirname(server), 'freshness-core.mjs')));
const harness = await import('./mcp-harness-0138.mjs');
const touch = (...args) => { const out = spawnSync('/usr/bin/touch', args); assert.equal(out.status, 0, `touch ${args.join(' ')}: ${out.stderr}`); };
// Same bytes, same mtime to the nanosecond, new ctime: what a download from the cloud does to the file's dates.
const downloadLike = async (file, bytes) => { const ref = `${file}.ref`; await fs.writeFile(ref, ''); touch('-r', file, ref); await fs.writeFile(file, bytes); touch('-r', ref, file); await fs.rm(ref); };
const stat = file => fs.lstat(file, { bigint: true });

if (process.env.CLOUD_PART !== 'server') {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cloud-core-')));
  const root = path.join(temp, 'selected'); await fs.mkdir(root);
  const names = ['downloaded', 'downloaded-edited-mtime', 'downloaded-edited-size', 'legacy-row', 'still-cloud'];
  const files = Object.fromEntries(names.map(name => [name, path.join(root, `${name}.md`)]));
  const text = name => `# ${name}\nsynthetic text of ${name}.\n`;
  for (const name of names) await fs.writeFile(files[name], text(name));
  const indexText = Object.values(files).map(file => `${file}\tT\t-\t-`).join('\n') + '\n';
  const live = Object.values(files);
  const cloud = new Set([files['downloaded'], files['downloaded-edited-mtime'], files['downloaded-edited-size'], files['still-cloud']]);
  const baseline = await captureFreshnessBaseline({ roots: [root], indexText, datalessAmong: all => new Set(all.filter(file => cloud.has(file))) });
  const rows = Object.fromEntries(baseline.split('\n').filter(line => line && !line.startsWith('#')).map(line => [decodeURIComponent(line.split('\t')[0]), line.split('\t')]));
  assert.equal(rows[files['downloaded']][6], '-', 'precondition: cloud-only at baseline = no digest');
  assert.match(rows[files['legacy-row']][6], /^[0-9a-f]{64}$/, 'precondition: the local one has a digest');
  // a 0.1.43-format row: five metadata columns and nothing after them
  const legacy = baseline.split('\n').map(line => line && !line.startsWith('#') && decodeURIComponent(line.split('\t')[0]) === files['legacy-row'] ? line.split('\t').slice(0, 6).join('\t') : line).join('\n');
  const before = {}; for (const name of names) before[name] = await stat(files[name]);
  await downloadLike(files['downloaded'], text('downloaded'));
  await downloadLike(files['downloaded-edited-mtime'], text('downloaded-edited-mtime'));
  await fs.utimes(files['downloaded-edited-mtime'], new Date(), new Date(Date.now() + 3600e3));   // a real edit moves the mtime
  await fs.writeFile(files['downloaded-edited-size'], 'a much longer replacement text, edited after the download.\n');
  await downloadLike(files['legacy-row'], text('legacy-row'));
  for (const name of ['downloaded', 'legacy-row']) {
    const now = await stat(files[name]);
    assert.equal(now.mtimeNs, before[name].mtimeNs, `precondition: ${name} kept its mtime`); assert.notEqual(now.ctimeNs, before[name].ctimeNs, `precondition: ${name} has a new ctime`);
  }
  // the still-cloud file is untouched except for a chmod that would make any open fail
  await fs.chmod(files['still-cloud'], 0o000);
  const result = await checkFreshness({ roots: [root], indexText, livePaths: live, baselineText: legacy, datalessAmong: all => new Set(all.filter(file => file === files['still-cloud'])) });
  assert.deepEqual(result.changed, [files['downloaded-edited-mtime'], files['downloaded-edited-size'], files['legacy-row']].sort(), `downloaded with the same size and mtime is NOT changed; edits and the legacy row are:\n${JSON.stringify(result)}`);
  // the next baseline hashes the downloaded file (its metadata moved) and still does not open the cloud-only one
  const next = await captureFreshnessBaseline({ roots: [root], indexText, previousText: baseline, datalessAmong: all => new Set(all.filter(file => file === files['still-cloud'])) });
  const nextRows = Object.fromEntries(next.split('\n').filter(line => line && !line.startsWith('#')).map(line => [decodeURIComponent(line.split('\t')[0]), line.split('\t')]));
  assert.match(nextRows[files['downloaded']][6], /^[0-9a-f]{64}$/, 'the next baseline records a digest for the downloaded file');
  assert.equal(nextRows[files['still-cloud']][6], '-', 'a file still cloud-only is not opened and has no digest');
  console.log('PASS core: a downloaded file with the same size and mtime is unchanged; edits and legacy rows are not');
  await fs.chmod(files['still-cloud'], 0o600); await fs.rm(temp, { recursive: true, force: true });
  if (process.env.CLOUD_PART === 'core') process.exit(0);
}

// ---------- part 2: a real server ----------
const { temp, home, docs, dataHome } = await harness.fakeHome('cloud-download');
const { sleep, until } = harness;
const note = name => path.join(docs, `${name}.md`);
const bodies = { stable: '# Stable\ncloudstablemark text one.\n', fetched: '# Fetched\ncloudfetchedmark was online-only.\n', other: '# Other\ncloudothermark first version.\n' };
for (const [name, body] of Object.entries(bodies)) await fs.writeFile(note(name), body);
const s = harness.startServer({ home, roots: [docs], env: { DATABRAIN_FRESHNESS_CHECK_MS: '100' } });
const baselineFile = path.join(dataHome, 'moc', 'source-freshness.tsv');
const rowOf = async file => (await fs.readFile(baselineFile, 'utf8')).split('\n').find(line => line.startsWith(encodeURIComponent(file) + '\t'))?.split('\t');
const quiet = async () => until(async () => { const t = await s.tool('databrain_setup_status'); return /Stage: ready\./.test(t) && !/Running now/.test(t); }, 'idle', 240000);
try {
  await harness.initialize(s); await harness.setupToReady(s); await quiet(); await sleep(1500);
  const fetched = await fs.realpath(note('fetched'));
  const row = await rowOf(fetched);
  assert.match(row[6], /^[0-9a-f]{64}$/, `precondition: a digest was recorded at setup:\n${row}`);
  // Shape the baseline like Mel's: this file was cloud-only when the baseline was taken, so its row has no digest.
  await fs.writeFile(baselineFile, (await fs.readFile(baselineFile, 'utf8')).split('\n').map(line => line.startsWith(encodeURIComponent(fetched) + '\t') ? line.split('\t').slice(0, 6).join('\t') + '\t-' : line).join('\n'));
  // The download: same bytes, same size and mtime, new ctime.
  await downloadLike(note('fetched'), bodies.fetched);
  await sleep(600);
  const jobsBefore = (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(l => /\tjob-start\t/.test(l)).length;
  await s.tool('databrain_search', { query: 'cloudfetchedmark' });   // the on-use freshness check
  await sleep(1500);
  const health = await s.tool('databrain_health');
  const audit = await s.tool('databrain_verify_install');
  const line = audit.split('\n').find(l => /Selected-source health/.test(l)) || '';
  assert(/Source freshness: current\./.test(health), `a downloaded file leaves the health report at current:\n${health}`);
  assert(/freshness current/.test(line), `and the install audit says freshness is current:\n${line}`);
  const jobsAfter = (await fs.readFile(path.join(dataHome, '.databrain', 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(l => /\tjob-start\t/.test(l)).length;
  assert.equal(jobsAfter, jobsBefore, 'and no refresh was started for it');
  // A real edit of another file refreshes the index and rewrites the baseline: the downloaded file now has its digest.
  await fs.writeFile(note('other'), '# Other\ncloudothermark second version, longer.\n');
  await sleep(600);
  await until(async () => { await s.tool('databrain_search', { query: 'cloudothermark' }); const r = await rowOf(fetched); return /^[0-9a-f]{64}$/.test(r?.[6] || ''); }, 'the next baseline records the downloaded file digest', 120000);
  console.log('PASS server: a downloaded file with the same size and mtime kept freshness current, and the next baseline recorded its digest');
} finally {
  s.child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
