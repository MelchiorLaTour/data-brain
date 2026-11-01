// 0.1.40: relationship report. >=5000 invented files in a fake HOME (same-size pairs, exact duplicates, unique-size binaries).
// 1 size filter: a unique-size binary is never opened (a read error planted on it does not show), a same-size one is opened.
// 2 online-only files (NB_TEST_DATALESS_LIST) are never opened and are recorded "cloud_only".
// 3 a read timeout on one file marks only that file "unreadable"; the report is still built and duplicates are still found.
// 4 after a FULL refresh (which deletes the report) the report is rebuilt by itself and verify_install passes; same after the report is deleted by hand.
// Time of step 1 is printed (measured, not guessed). Mutants (G40_MUTANT): no-size-filter, no-dataless, no-timeout-tolerance, no-auto-rebuild.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';

const SCENARIO = process.env.SCENARIO || 'big';   // big: steps 1-3 on 5000 files; refresh: step 4 on a small brain (a full refresh of 5000 files is just slow extraction)
const N = SCENARIO === 'big' ? Number(process.env.N || 5000) : 60;
let serverPath = process.env.DATABRAIN_SERVER;
let mutantDir = null;
if (process.env.G40_MUTANT) {
  mutantDir = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-g40-mutant-'));
  await fs.cp(path.dirname(path.dirname(path.dirname(serverPath))), path.join(mutantDir, 'pkg'), { recursive: true });
  serverPath = path.join(mutantDir, 'pkg', 'setup', 'mcp', 'server.mjs');
  let s = await fs.readFile(serverPath, 'utf8'); const before = s;
  const m = process.env.G40_MUTANT;
  if (m === 'no-size-filter') s = s.replace("&& sizeCounts.get(info.size) === 1;", "&& false;");
  if (m === 'no-dataless') s = s.replace("else if (datalessFiles.has(file)) record.sourceStatus = 'cloud_only';", "");
  if (m === 'utf8-digest') s = s.replace("digestHandle.createReadStream({ autoClose: false });", "digestHandle.createReadStream({ encoding: 'utf8', autoClose: false });").replace('decoder.write(chunk)', 'chunk').replace('digest.update(chunk);', 'digest.update(chunk);');
  if (m === 'no-timeout-tolerance') s = s.replace("if (!RELATIONSHIP_UNREADABLE_CODES.has(error.code)) throw error;", "throw error;");
  if (m === 'no-auto-rebuild') s = s.replace("  if (codexMode || relationshipRebuildRunning()) return;", "  return;");
  assert.notEqual(s, before, 'mutation applied'); await fs.writeFile(serverPath, s);
}
process.env.DATABRAIN_SERVER = serverPath;   // the harness reads it when it is imported, so it is imported only now
const { fakeHome, initialize, setupToReady, startServer, sleep, until } = await import('./mcp-harness-0138.mjs');
const { temp, home, docs, dataHome, statePath } = await fakeHome('g40');
const big = path.join(docs, 'bulk'); await fs.mkdir(big, { recursive: true });
await fs.writeFile(path.join(docs, 'seed.md'), '# Seed\ng40seed note.\n');
const kinds = ['md', 'txt', 'pdf'];
const rows = Array.from({ length: N }, (_, i) => path.join(big, `f${String(i).padStart(5, '0')}.${kinds[i % 3]}`));
const writeFiles = async () => {
  for (let i = 0; i < N; i++) {
    const kind = kinds[i % 3]; const file = rows[i];
    const body = kind === 'pdf' ? Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(2000 + i)])      // every pdf has its own size
      : Buffer.from(kind === 'md' ? `# Note ${i}\nsee [next](f${String((i + 3) % N).padStart(5, '0')}.md)\n${'text '.repeat(100 + (i % 17))}` : `note ${i}\n${'lorem '.repeat(100 + (i % 19))}`);
    await fs.writeFile(file, body);
  }
  // exact duplicate pairs (md -> md, 50 pairs) and same-size/different-content pairs (txt, 20 pairs)
  for (let k = 0; k < 100; k += 2) { await fs.copyFile(mdAt(k), mdAt(k + 1)); }
  for (let k = 200; k < 240; k += 2) { const a = await fs.readFile(txt(k)); await fs.writeFile(txt(k + 1), Buffer.from(a.toString().replace(/note \d+/, m => crypto.randomBytes(m.length).toString('hex').slice(0, m.length)))); }
  // (1) same size, differ ONLY in invalid-UTF-8 bytes (0xFF vs 0xFE decode to the same U+FFFD); (2) byte-identical binaries; (3) valid multi-byte text across chunk edges
  const body = crypto.randomBytes(4000).map(b => b % 128);
  const withBad = bad => { const copy = Buffer.from(body); [10, 500, 3000].forEach(i => { copy[i] = bad; }); return copy; };
  await fs.writeFile(extra[0], withBad(0xff)); await fs.writeFile(extra[1], withBad(0xfe));
  const same = crypto.randomBytes(5000); await fs.writeFile(extra[2], same); await fs.writeFile(extra[3], same);
  const uni = Buffer.from('é日本😀 text '.repeat(9000)); await fs.writeFile(extra[4], uni); await fs.writeFile(extra[5], uni);
  const decoded = uni.toString('utf8');
  assert.equal(createHash('sha256').update(uni).digest('hex'), createHash('sha256').update(decoded).digest('hex'), 'valid-text digest: raw bytes and decoded text hash alike (digests unchanged)');
};
const mdAt = k => rows[3 * k];
const txt = k => rows[3 * k + 1];
const planted = 52;   // 50 markdown copies + 1 byte-identical binary pair + 1 multi-byte text pair
const extra = ['bin-a.bin', 'bin-b.bin', 'bin-c.bin', 'bin-d.bin', 'uni-a.txt', 'uni-b.txt'].map(n => path.join(big, n));
let uniquePdf, sameSizeA, sameSizeB, cloudMd, cloudPdf, timeoutMd, readErrors = '';
const dlist = path.join(temp, 'dataless.txt');
if (SCENARIO === 'big') {
uniquePdf = rows.find((f, i) => i % 3 === 2 && i > 300);          // unique size: must never be opened
sameSizeA = txt(200); sameSizeB = txt(201);                          // same size, different content: opened, not duplicates
cloudMd = mdAt(150), cloudPdf = rows.find((f, i) => i % 3 === 2 && i > 600);
timeoutMd = mdAt(160);                                              // md: always read for links
await fs.writeFile(dlist, [cloudMd, cloudPdf].join('\n'));
readErrors = [path.basename(uniquePdf), path.basename(sameSizeA), path.basename(timeoutMd), path.basename(cloudMd), path.basename(cloudPdf)].join(',');

}

const server = startServer({ home, roots: [docs], env: { NB_TEST_DATALESS_LIST: dlist, DATABRAIN_TEST_RELATIONSHIP_READ_ERROR: readErrors, DATABRAIN_FRESHNESS_CHECK_MS: SCENARIO === 'big' ? '3600000' : '100' } });
const reportPath = path.join(dataHome, 'moc', 'relationships.tsv');
let lastStatus = ''; const idle = () => until(async () => { const t = lastStatus = await server.tool('databrain_setup_status'); return /Stage: (ready|verification pending)\./.test(t) && !/Running now/.test(t) && !/relationship report: running/.test(t); }, 'jobs idle', 300000);
const parse = async () => new Map((await fs.readFile(reportPath, 'utf8')).split('\n').filter(l => l && !l.startsWith('#')).map(l => { const c = l.split('\t'); return [decodeURIComponent(c[0].replace(/\+/g, ' ')), { group: c[5], status: c[7] }]; }));
const verifySetupLine = async () => (await server.tool('databrain_verify_install')).split('\n').find(l => l.includes('Setup contract'));
try {
  await initialize(server); await setupToReady(server);
  await idle();
  if (SCENARIO === 'big') {
  await writeFiles();
  await fs.rm(reportPath, { force: true });
  // index the bulk rows without the slow full pipeline: append rows, stage = relationships pending
  await fs.appendFile(path.join(dataHome, 'moc', 'index.tsv'), [...rows, ...extra].map((f, i) => `${f}\tf${i}\tdocuments\tnote,${i}`).join('\n') + '\n');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, JSON.stringify({ ...state, stage: 'relationships pending' }));
  const t0 = Date.now();
  await server.tool('databrain_build_relationships');
  await until(async () => { try { await fs.stat(reportPath); return true; } catch { return false; } }, 'report written', 600000);
  const ms = Date.now() - t0;
  console.log(`MEASURED: report for ${N + 1} files built in ${ms} ms (${(ms / N).toFixed(2)} ms/file)`);
  const report = await parse();
  assert(report.size >= N, `report has a row per file: ${report.size}`);
  // 1 size filter
  assert.equal(report.get(uniquePdf).status, 'available', 'unique-size binary was not opened (a planted read error never fired)');
  assert.equal(report.get(sameSizeA).status, 'unreadable', 'a same-size file IS opened (planted read error fired)');
  // 2 online-only
  assert.equal(report.get(cloudMd).status, 'cloud_only', 'online-only markdown recorded cloud_only, not opened');
  assert.equal(report.get(cloudPdf).status, 'cloud_only', 'online-only binary recorded cloud_only, not opened');
  // 3 timeout on one file
  assert.equal(report.get(timeoutMd).status, 'unreadable', 'timed-out file is unreadable');
  const groups = new Set([...report.values()].map(v => v.group).filter(g => g && g !== '-'));
  assert.equal(groups.size, planted, `duplicates still found: ${groups.size} groups for ${planted} planted pairs`);
  assert(report.get(mdAt(0)).group !== '-' && report.get(mdAt(0)).group === report.get(mdAt(1)).group, 'a planted pair shares a group');
  assert.equal(report.get(sameSizeB).group, '-', 'same size, different content: not a duplicate');
  assert.equal(report.get(extra[0]).group, '-', 'two same-size binaries that differ only in invalid-UTF-8 bytes are NOT a duplicate group');
  assert.equal(report.get(extra[1]).group, '-', 'same, other side');
  assert(report.get(extra[2]).group !== '-' && report.get(extra[2]).group === report.get(extra[3]).group, 'byte-identical binaries ARE a duplicate group');
  assert(report.get(extra[4]).group !== '-' && report.get(extra[4]).group === report.get(extra[5]).group, 'identical multi-byte text across chunk edges is still a group');
  const links = (await fs.readFile(reportPath, 'utf8')).split('\n').filter(l => l.includes('bulk%2Ff00003.md') || l.includes('f00003.md')).length;
  assert(links > 0, 'markdown links are still recorded');
  console.log('PASS g40 big');
  } else {
  // 4 auto-rebuild
  await fs.writeFile(path.join(docs, 'edit.md'), '# Edit\nnew note for the refresh.\n');
  await server.tool('databrain_search', { query: 'g40seed' }); await idle();
  console.log('verify before the refresh:', await verifySetupLine());
  await server.tool('databrain_refresh');
  await until(async () => { try { await fs.stat(reportPath); return true; } catch { return false; } }, 'report rebuilt after full refresh', 600000)
    .catch(() => {});
  await idle();
  const afterRefresh = await verifySetupLine();
  console.log('verify after a FULL refresh:', afterRefresh);
  assert(/^PASS: Setup contract/.test(afterRefresh) && /relationship report present/.test(afterRefresh), 'refresh -> report rebuilt automatically -> verify PASS');
  await fs.rm(reportPath, { force: true });
  await server.tool('databrain_setup_status'); await idle();
  assert(/^PASS: Setup contract/.test(await verifySetupLine()), 'report deleted by hand -> rebuilt by itself');
  console.log('PASS g40 refresh');
  }
} catch (error) { console.error('LAST STATUS:\n' + lastStatus); throw error; } finally { server.child.kill('SIGTERM'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); if (mutantDir) await fs.rm(mutantDir, { recursive: true, force: true }).catch(() => {}); }
