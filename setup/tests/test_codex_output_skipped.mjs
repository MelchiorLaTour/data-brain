// Part 25 E + part 26: ChatGPT's own per-chat output folder (~/Documents/Codex) is not the user's notes. On the ChatGPT host it is skipped by default and
// files already indexed from it leave the index on the next refresh, EXCEPT the .txt and .md notes ChatGPT saves when asked (part 26: those stay indexed, privacy screen applies); the Claude host is as shipped (0.1.48), which this test also pins.
// Fake HOME, invented files. DATABRAIN_SKIP_CODEX_OUTPUT=0 is how the first ChatGPT run indexes the folder the way an older build did.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS; delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 240000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-codexout-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); const codexDir = path.join(docs, 'Codex', '2026-11-18', 'chat-one');
await fs.mkdir(codexDir, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'garden.md'), '# Garden\nMy notes: the trellis code is gardenmarker.\n');
await fs.writeFile(path.join(await fs.realpath(codexDir), 'scratch.md'), '# Scratch\nChatGPT wrote this while answering: codexoutmarker draft.\n');
await fs.writeFile(path.join(await fs.realpath(codexDir), 'draft.txt'), 'codexoutmarker plain text draft written by ChatGPT\n');
const codexReal = await fs.realpath(codexDir);
await fs.writeFile(path.join(codexReal, 'old.rtf'), '{\\rtf1 codexrtfmarker an rtf ChatGPT wrote}\n');
await fs.writeFile(path.join(codexReal, 'tool.py'), 'print("codexpymarker")\n');
await fs.writeFile(path.join(codexReal, 'data.json'), '{"k":"codexjsonmarker"}\n');
await fs.writeFile(path.join(codexReal, 'shot.png'), 'not really a png codexpngmarker\n');
const servers = [];
function start(extraEnv = {}) {
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, DATABRAIN_TEST_HOUSEKEEPING_IDLE_MS: '300', HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: process.env.TEST_FRESHNESS_MS || '100', ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  servers.push(child);
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  return { child, call, init: async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}
const ready = async server => until(async () => {
  const status = await server.call('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.call('databrain_privacy', { action: 'decide', keep: [] });
  return /Stage: (?:verification pending|ready)\./.test(status);
}, 'setup reaches ready');
// a hit shows the file's path; "no matches for: <query>" echoes the query, so the word itself proves nothing
const fromCodex = text => /Documents\/Codex\/2026-11-18\/chat-one\//.test(text);
const fromGarden = text => /garden\.md/.test(text);
try {
  // 1. the folder is indexed first (older build, or the Claude host as shipped)
  const first = start(chatgpt ? { DATABRAIN_SKIP_CODEX_OUTPUT: '0' } : {});
  await first.init();
  if (chatgpt) { await first.call('databrain_setup_start', { folders: [realDocs] }); await first.call('databrain_setup_start', { folders: [realDocs], confirmed: true }); }
  else await first.call('databrain_setup_start');
  await ready(first);
  assert(fromCodex(await first.call('databrain_search', { query: 'codexoutmarker' })), 'precondition: the Codex output files were indexed before the rule');
  assert(fromGarden(await first.call('databrain_search', { query: 'gardenmarker' })), 'precondition: the ordinary note was indexed');
  first.child.kill(); await sleep(1500);
  if (!chatgpt) {
    // Claude host: unchanged, the folder stays indexed (a refresh does not drop it)
    const claude = start(); await claude.init();
    await fs.writeFile(path.join(realDocs, 'garden.md'), '# Garden\nMy notes: the trellis code is gardenmarker and a second line.\n');
    await sleep(1500); await claude.call('databrain_refresh');
    await until(async () => /second line/.test(await claude.call('databrain_search', { query: 'gardenmarker' })), 'the edit is searchable');
    assert(fromCodex(await claude.call('databrain_search', { query: 'codexoutmarker' })), 'Claude host: ~/Documents/Codex is indexed as shipped');
    console.log('Claude host: ~/Documents/Codex unchanged (as shipped): PASS');
  } else {
    // 2. the ChatGPT host, default settings: what ChatGPT wrote that is not a note leaves the index; the .txt and .md notes stay and new ones are picked up
    const second = start(); await second.init();
    await fs.writeFile(path.join(realDocs, 'garden.md'), '# Garden\nMy notes: the trellis code is gardenmarker and a second line.\n');
    await sleep(1500); await second.call('databrain_refresh');
    await until(async () => /second line/.test(await second.call('databrain_search', { query: 'gardenmarker' })), 'the edit is searchable');
    await until(async () => !/old\.rtf/.test(await second.call('databrain_search', { query: 'codexrtfmarker' })), 'an .rtf already indexed from ~/Documents/Codex leaves the index (gate b)');
    assert(fromCodex(await second.call('databrain_search', { query: 'codexoutmarker' })), 'the .md and .txt notes already indexed from ~/Documents/Codex stay');
    // gate (a): a note ChatGPT writes now becomes searchable by itself (no manual refresh); measure how long that takes
    const wrote = Date.now();
    await fs.writeFile(path.join(codexReal, 'rule-check.txt'), 'codexoutlater is a note ChatGPT wrote after the rule.\n');
    await until(async () => /rule-check\.txt/.test(await second.call('databrain_search', { query: 'codexoutlater' })), 'a new .txt note in ~/Documents/Codex becomes searchable', 120000);
    const seconds = ((Date.now() - wrote) / 1000).toFixed(1);
    await fs.writeFile(path.join(codexReal, 'later.md'), '# Later\ncodexoutmd is a markdown note ChatGPT wrote after the rule.\n');
    await until(async () => /later\.md/.test(await second.call('databrain_search', { query: 'codexoutmd' })), 'a new .md note in ~/Documents/Codex becomes searchable', 120000);
    console.log(`MEASURED: .txt written to searchable (fake brain, no manual refresh): ${seconds} s`);
    // gate (b): code, data and images beside it stay out of the index, the search and the file inventory
    await fs.writeFile(path.join(codexReal, 'newcode.py'), 'print("codexpymarker2")\n');
    await fs.writeFile(path.join(codexReal, 'newdoc.rtf'), '{\\rtf1 codexrtfmarker2}\n');
    // gate (c): the privacy screen still applies to a note there: a planted secret is held back
    await fs.writeFile(path.join(codexReal, 'safe-note.txt'), 'codexsafemarker a harmless shopping list written by ChatGPT\n');
    await fs.writeFile(path.join(codexReal, 'rent-memo.txt'), 'codexsecretmarker send the rent to FR1420041010050500013M02606 thanks\n');
    await sleep(1500); await second.call('databrain_refresh');
    await sleep(6000);
    for (const marker of ['codexpymarker', 'codexjsonmarker', 'codexpngmarker', 'codexpymarker2', 'codexrtfmarker2']) assert(!fromCodex(await second.call('databrain_search', { query: marker })), `${marker}: a non-note file in ~/Documents/Codex is not indexed`);
    assert(/safe-note\.txt/.test(await second.call('databrain_search', { query: 'codexsafemarker' })), 'control: a harmless .txt written beside the secret one is found, so the secret one is missing because of the privacy screen');
    const secretReply = await second.call('databrain_search', { query: 'codexsecretmarker' });
    assert(!/FR1420041010050500013M02606|rent-memo/.test(secretReply), 'a secret in a .txt under ~/Documents/Codex is held back by the privacy screen');
    // no refresh loop: the freshness scan and the ingest agree on what is in, so the index settles and stops refreshing
    const countRefreshes = async () => (await fs.readFile(path.join(home, 'DataBrain', '.databrain', 'stage-timing.log'), 'utf8')).split('\n').filter(line => /\trefresh\t[0-9a-f]+\tjob-start\t/.test(line)).length;
    await sleep(4000);
    assert(await countRefreshes() <= 9, `the index settled instead of refreshing again and again (${await countRefreshes()} refresh jobs)`);
    const settledAt = await countRefreshes();
    for (let i = 0; i < 5; i++) { await sleep(700); await second.call('databrain_search', { query: 'gardenmarker' }); }
    await sleep(1500);
    assert.equal(await countRefreshes(), settledAt, 'five more questions started no refresh: the freshness scan agrees with the ingest about ~/Documents/Codex');
    // the file inventory (redrawn by housekeeping) lists the notes and none of the other files
    await until(async () => { const t = await fs.readFile(path.join(home, 'DataBrain', 'moc', 'inventory.tsv'), 'utf8').catch(() => ''); return t.includes('Documents/Codex/') && !/Documents\/Codex\/[^\n]*\.(py|json|png|rtf)/.test(t); }, 'the file inventory lists the .txt and .md notes in ~/Documents/Codex and no code, data, image or rtf', 120000);
    // a Codex folder somewhere else (not ~/Documents/Codex) is an ordinary folder
    console.log('ChatGPT host: ~/Documents/Codex keeps only .txt and .md notes (indexed, privacy screened, no refresh loop); other files skipped and old rows dropped: PASS');
  }
} finally { for (const child of servers) child.kill(); if (!process.env.KEEP_TEMP) await fs.rm(temp, { recursive: true, force: true }); else console.log("kept", temp); }
