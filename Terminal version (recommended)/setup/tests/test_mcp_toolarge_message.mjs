// A file whose text is over the 20,000,000-character read ceiling (0.1.30 stress test, 2026-10-15) is title-only. Its read said "No extracted
// text is available for this file. Refresh setup after installing a supported extractor." (wrong: nothing is missing, the file is too big) and
// the status listed it nowhere. Now the read says it is too large to read in full, and the status counts it. A normal PDF is unaffected.
// The PDF extractor is a stub in an engine copy (the first line of the fake file picks the size); fake files only.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-toolarge-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); const engineDir = path.join(temp, 'engine');
await fs.mkdir(docs, { recursive: true });
// An engine copy whose PDF extractor is a stub (without pdftotext on the engine's PATH extract.sh runs /usr/bin/osascript on setup/mcp/pdf-extract.js):
// the first line of the fake file picks the size, as in test_extract_long_text.sh.
await fs.cp(path.join(here, '../../bin'), path.join(engineDir, 'bin'), { recursive: true });
await fs.mkdir(path.join(engineDir, 'setup', 'mcp'), { recursive: true });
await fs.writeFile(path.join(engineDir, 'setup', 'mcp', 'pdf-extract.js'), `ObjC.import('Foundation');
function run(argv) {
  const head = ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(argv[0], 4, $())).slice(0, 8);
  const chunk = 'word '.repeat(100000);                                  // 500,000 characters
  return head === 'HUGETEXT' ? chunk.repeat(42) + ' hugeendmarker' : 'smallword smallendmarker';   // 21,000,000 characters vs a few
}
`);
await fs.writeFile(path.join(docs, 'huge-atlas.pdf'), 'HUGETEXT\n');
await fs.writeFile(path.join(docs, 'small-memo.pdf'), 'SMALLDOC\n');
await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\ntoolargemarker an ordinary note.\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, label, limit = 150000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };
const dataHome = path.join(home, 'DataBrain');
const savedStage = async () => JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8')).stage;

function start(env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_ENGINE_DIR: engineDir, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise((resolve, reject) => { const id = ++n; const timer = setTimeout(() => reject(new Error(`no answer to ${method} in 120 s (did the server exit?)`)), 120000); waiting.set(id, m => { clearTimeout(timer); resolve(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  const ready = ask('initialize', { protocolVersion: '2025-03-26' }).then(() => child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'));
  return { child, tool, ready };
}
const servers = [];
setTimeout(() => { console.error('FAIL: the test ran longer than 15 minutes'); process.exit(1); }, 15 * 60 * 1000).unref();
try {
  const s = start({ DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }); servers.push(s); await s.ready;
  await s.tool('databrain_setup_start');
  await until(async () => (await savedStage().catch(() => '')) === 'ready', 'setup reaches ready', 240000);
  const readOf = async query => { const found = await s.tool('databrain_search', { query }); const file = (found.match(/\S*\.pdf/) || [''])[0]; assert(file, `${query} is found:\n${found}`); return s.tool('databrain_read', { path: file.replace(/^~/, home) }); };
  const huge = await readOf('huge atlas');
  assert(/too large to read in full/.test(huge), `the over-ceiling file says it is too large:\n${huge}`);
  assert(!/install|extractor/i.test(huge), `and does not send the user to install an extractor:\n${huge}`);
  const small = await readOf('small memo');
  assert(/smallendmarker/.test(small), `a normal PDF still reads:\n${small}`);
  const status = await s.tool('databrain_setup_status');
  assert(/1 is too large to read in full/.test(status), `the status counts the too-large file:\n${status}`);
  assert(/0 could not be read/.test(status), `and does not call it a read error:\n${status}`);
  console.log('PASS: a file over the 20,000,000-character ceiling says it is too large to read in full (not "install an extractor") and the status counts it; a normal PDF still reads.');
} finally {
  for (const s of servers) s.child.kill('SIGKILL');
  await sleep(1500);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
