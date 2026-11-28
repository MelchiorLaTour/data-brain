// Files that could not be read are COUNTED, never named (a name that failed to read cannot be screened by its text, and a
// private-looking name must not reach the chat). Scanned PDFs (they open, but have no text layer) are counted apart from real read
// errors, in status and diagnostics. DataBrain does not run OCR. Also: the indexing progress line counts real extractions and
// reports re-checked, skipped files separately.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-unreadable-')));
const home = path.join(temp, 'home');
const docs = path.join(home, 'Docs');
await fs.mkdir(docs, { recursive: true });
const real = await fs.realpath(docs);
const dataHome = path.join(home, 'DataBrain');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 180000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

// A valid one-page PDF with no text at all: what a scanned image looks like to a text extractor.
const BLANK_PDF = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R/Size 4>>\n%%EOF\n';
await fs.writeFile(path.join(real, 'steady.md'), '# Steady\nunreadablemarker an ordinary note.\n');
await fs.writeFile(path.join(real, 'zanzibar-scan-0001.pdf'), BLANK_PDF);
await fs.writeFile(path.join(real, 'Lettre Dupont licenciement.pdf'), 'this is not a pdf at all\n');   // a read error; its name must never be printed

async function session(env, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', real], { env: { ...process.env, HOME: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGKILL'); }
}

try {
  await session({}, async tool => {
    await tool('databrain_setup_start');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished');
    for (const [label, text] of [['status', await tool('databrain_setup_status')], ['diagnostics', await tool('databrain_diagnostics')]]) {
      assert(/Extraction exceptions: 1 could not be read; 1 are scanned images with no text layer/.test(text), `${label} must split read errors from scanned images with counts:\n${text.slice(0, 1500)}`);
      for (const name of ['Dupont', 'licenciement', 'zanzibar', 'scan-0001']) assert(!text.includes(name), `${label} must never print the name of a file that failed to read ("${name}")`);
    }
  });

  // progress line on a resumed run (state and progress file faked on the finished brain; no maintenance runs in step-by-step mode)
  await session({ DATABRAIN_TEST_STEP_BY_STEP: '1' }, async tool => {
    const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
    const saved = await fs.readFile(statePath, 'utf8');
    await fs.writeFile(statePath, JSON.stringify({ ...JSON.parse(saved), stage: 'indexing' }));
    await fs.writeFile(path.join(dataHome, 'moc', 'extract-progress.txt'), '12 30 45\n');
    const status = await tool('databrain_setup_status');
    assert(/Extracted about 12 files in this run; 30 files already done earlier were re-checked and skipped \(not counted as work\)\. Checked 45 of \d+ files \(\d+%/.test(status), `resumed progress must count real work apart from skipped files:\n${status.slice(0, 1200)}`);
    await fs.writeFile(path.join(dataHome, 'moc', 'extract-progress.txt'), '7\n');
    assert(/Extracted about 7 of \d+ files \(\d+%/.test(await tool('databrain_setup_status')), 'the older one-number progress file still reads');
    await fs.writeFile(statePath, saved);
    await fs.rm(path.join(dataHome, 'moc', 'extract-progress.txt'));
  });
  console.log('PASS: unreadable files are counted, never named; scanned PDFs are counted apart from read errors in status and diagnostics; progress separates real extractions from re-checked, skipped files.');
} finally {
  await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
