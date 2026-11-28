// Gap G6 (report only): note_folder ask_each_time / set while another process rewrites desktop-state.json every N ms.
// The writer does read -> change updatedAt -> write temp -> rename, like the indexing job does at its step boundaries; the only way it can
// undo a choice is by reading just before the server writes and renaming just after. 200 attempts per interval; success = the tool says Done
// AND the state still holds the choice 300 ms later. Intervals: 5 ms (WORST CASE, far harsher than a real job), 50 ms, 200 ms.
// Mutant (GAP_MUTANT=no-retry): the server checks once and gives up -> the success rate must drop at 5 ms.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, initialize, setupToReady, sleep, startServer } from './mcp-harness-0138.mjs';
import { stagePackage } from './mcp-harness-gaps.mjs';

const { temp, home, docs, statePath } = await fakeHome('gap-g6');
const server_ = await stagePackage('0.1.38', path.join(temp, 'pkg'));
if (process.env.GAP_MUTANT === 'no-retry') {
  const s = await fs.readFile(server_, 'utf8');
  const m = s.replace("for (let attempt = 0; attempt < 6; attempt += 1) {\n    const next = { ...(await readState()), ...set", "for (let attempt = 0; attempt < 1; attempt += 1) {\n    const next = { ...(await readState()), ...set");
  assert.notEqual(m, s, 'mutation applied'); await fs.writeFile(server_, m);
}
const inbox = path.join(docs, 'inbox'); await fs.mkdir(inbox);
await fs.writeFile(path.join(docs, 'plan.md'), '# Plan\ngapstressmarker note.\n');
const writerScript = path.join(temp, 'writer.mjs');
await fs.writeFile(writerScript, `import fs from 'node:fs';
const [file, ms] = [process.argv[2], Number(process.argv[3])];
let n = 0;
setInterval(() => { try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); s.updatedAt = new Date().toISOString(); const t = file + '.writer' + (n++) + '.tmp'; fs.writeFileSync(t, JSON.stringify(s, null, 2) + '\\n'); fs.renameSync(t, file); } catch {} }, ms);
`);
const server = startServer({ home, roots: [docs], env: { DATABRAIN_SERVER: server_ } });
// startServer reads DATABRAIN_SERVER when the harness is imported, so use the unzipped package explicitly:
server.child.kill('SIGTERM');
const { default: readline } = await import('node:readline');
const run = () => {
  const child = spawn(process.execPath, [server_, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, ask, tool: async (name, args = {}) => { const r = await ask('tools/call', { name, arguments: args }); return r.result?.content?.[0]?.text ?? r.error?.message ?? ''; } };
};
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
let s, writer;
try {
  s = run(); await initialize(s); await setupToReady(s);
  const report = [];
  for (const ms of [5, 50, 200]) {
    writer = spawn(process.execPath, [writerScript, statePath, String(ms)], { stdio: 'ignore' });
    await sleep(300);
    let ok = 0, notRecorded = 0, otherErrors = 0, lostLater = 0;
    for (let i = 0; i < 200; i += 1) {
      const wantAsk = i % 2 === 0;
      const reply = wantAsk ? await s.tool('databrain_note_folder', { action: 'ask_each_time' }) : await s.tool('databrain_note_folder', { action: 'set', folder: inbox });
      if (/could not be recorded/.test(reply)) { notRecorded += 1; continue; }
      if (!/^Done\./.test(reply)) { otherErrors += 1; continue; }
      await sleep(300);
      const st = await state();
      const holds = wantAsk ? st.noteDefaultFolder === undefined && st.noteFolderAsked === true : st.noteDefaultFolder === inbox;
      if (holds) ok += 1; else lostLater += 1;
    }
    writer.kill('SIGTERM'); await sleep(300);
    report.push({ ms, attempts: 200, ok, notRecorded, lostAfterDone: lostLater, otherErrors });
    console.log(`G6 writer every ${ms} ms${ms === 5 ? ' (WORST CASE)' : ''}: ${ok}/200 ok, "could not be recorded" ${notRecorded}, said Done but lost within 300 ms ${lostLater}, other errors ${otherErrors}`);
  }
  assert.equal(report.length, 3);
  console.log('G6 REPORT-ONLY DONE');
} finally {
  writer?.kill('SIGTERM'); s?.child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
