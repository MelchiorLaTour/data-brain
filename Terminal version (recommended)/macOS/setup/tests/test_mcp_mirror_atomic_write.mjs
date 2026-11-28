// An app page in the mirror must never be visible with a half-finished fingerprint (new text, but the file's own date not set yet).
// An index build that read it in that moment failed "approved source changed during read" (seen under load, 2026-10-11).
// Synthetic files only. A second process looks at the folder in a tight loop while 400 pages are written.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const readers = await import(process.env.DATABRAIN_APP_READERS || path.join(here, '../mcp/app-readers.mjs'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-atomic-')));
const dir = path.join(temp, 'Datebook', 'Home');
await fs.mkdir(dir, { recursive: true });
const dateMs = Date.parse('2026-01-03T10:00:00Z');
const watcherCode = `
const fs = require('fs'), path = require('path');
const dir = process.argv[1], want = Number(process.argv[2]); let bad = 0, seen = 0, hidden = 0;
const stop = Date.now() + 60000;
process.stdin.on('data', () => { console.log(JSON.stringify({ bad, seen, hidden })); process.exit(0); });
(function loop() {
  let names = []; try { names = fs.readdirSync(dir); } catch {}
  for (const name of names) {
    if (name.startsWith('.')) { hidden++; continue; }
    if (!name.endsWith('.md')) continue;
    try { const info = fs.statSync(path.join(dir, name)); seen++; if (Math.abs(info.mtimeMs - want) >= 1) bad++; } catch {}
  }
  if (Date.now() < stop) setImmediate(loop);
})();`;
const watcher = spawn(process.execPath, ['-e', watcherCode, dir, String(dateMs)], { stdio: ['pipe', 'pipe', 'inherit'] });
let out = ''; watcher.stdout.on('data', d => { out += d; });
await new Promise(resolve => setTimeout(resolve, 400));   // the watcher is running before the first write
try {
  for (let i = 0; i < 400; i++) {
    const file = path.join(dir, `Page ${i} [${String(i).padStart(4, '0')}].md`);
    await readers.writeMirrorFile(file, `# Page ${i}\n\n${'text '.repeat(200)}${i}\n`, new Date(dateMs));
  }
  await new Promise(resolve => setTimeout(resolve, 300));
  watcher.stdin.write('stop\n');
  await new Promise(resolve => watcher.on('close', resolve));
  const result = JSON.parse(out.trim().split('\n').pop());
  assert(result.seen > 0, `the watcher saw the pages: ${out}`);
  assert.equal(result.bad, 0, `a page was visible with the wrong date (half-finished): ${out}`);
  const left = (await fs.readdir(dir)).filter(n => n.startsWith('.'));
  assert.deepEqual(left, [], `no half-written file is left behind: ${left}`);
  const files = (await fs.readdir(dir)).filter(n => n.endsWith('.md'));
  assert.equal(files.length, 400, 'all 400 pages are there');
  assert.equal((await fs.stat(path.join(dir, files[0]))).mtimeMs, dateMs, 'and carry the item date');
  console.log(`PASS: 400 pages written while another process watched (${result.seen} looks): none seen with a wrong date, no leftover file.`);
} finally {
  watcher.kill('SIGKILL');
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
