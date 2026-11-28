// Part 28 B: Mel's retest showed databrain_capture answering "err" twice (32 and 39 ms) before "ok". A call that fails that fast is refused before any
// work starts: the arguments were wrong. Two causes are closed here and the call log now says which kind of refusal it was:
//  1. ChatGPT's tool text and schema had lost the keyword rule (Part 25 B dropped minItems/pattern and the slim text dropped the sentence): the served
//     ChatGPT capture text must say keywords are 2-12 lowercase, and "keywords" must stay required.
//  2. ChatGPT names folders in plain words ("Documents") and passes the word back: a bare name that matches one approved folder now means that folder
//     (ChatGPT only; Claude keeps the full-path rule).
//  3. The log line for an error carries one category word from a fixed list, never the note text, title, folder or path.
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
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-caperr-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(docs, { recursive: true });
const realDocs = await fs.realpath(docs);
await fs.writeFile(path.join(realDocs, 'plain.md'), '# Plain\ncaperrplainmarker an ordinary note.\n');
const dataHome = path.join(home, 'DataBrain'); const stateDir = path.join(dataHome, '.databrain');
let server = null;
function start() {
  const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-source-roots', realDocs])], { env: { ...process.env, HOME: home, DATABRAIN_TEST_LOCK_POLL_MS: '200' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  return { child, ask, call: async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '', init: async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}
const callLines = async () => (await fs.readFile(path.join(stateDir, 'stage-timing.log'), 'utf8').catch(() => '')).split('\n').filter(line => /\ttool-call\t/.test(line) && /databrain_capture/.test(line)).map(line => line.split('\t').slice(5).join('\t'));
try {
  server = start(); await server.init();
  if (chatgpt) {
    const tools = (await server.ask('tools/list', {})).result.tools; const capture = tools.find(tool => tool.name === 'databrain_capture');
    assert(/Keywords: 2-12 lowercase/.test(capture.description), `the served ChatGPT capture text says what keywords are: ${capture.description.slice(-120)}`);
    assert(capture.inputSchema.required.includes('keywords'), 'keywords stay required in the ChatGPT schema');
    console.log('ChatGPT capture text names the keyword rule and keeps keywords required: PASS');
    await server.call('databrain_setup_start', { folders: [realDocs] }); await server.call('databrain_setup_start', { folders: [realDocs], confirmed: true });
  } else await server.call('databrain_setup_start');
  await until(async () => {
    const status = await server.call('databrain_setup_status');
    if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.call('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: (?:verification pending|ready)\./.test(status);
  }, 'setup reaches ready');

  const secretTitle = 'Zebra budget plan'; const secretBody = 'caperrbodymarker the zebra costs money';
  // refusals: each logs "databrain_capture err <category>" and nothing else
  const noKeywords = await server.call('databrain_capture', { title: secretTitle, body: secretBody, folder: realDocs });
  assert(/^DataBrain: Provide 2.12 valid lowercase search keywords/.test(noKeywords), `no keywords is refused: ${noKeywords}`);
  const upper = await server.call('databrain_capture', { title: secretTitle, body: secretBody, folder: realDocs, keywords: ['Zebra', 'Budget'] });
  assert(/^DataBrain: Provide 2.12 valid lowercase search keywords/.test(upper), `uppercase keywords are refused: ${upper}`);
  const relative = await server.call('databrain_capture', { title: secretTitle, body: secretBody, folder: 'somewhere/else', keywords: ['zebra', 'budget'] });
  assert(/^DataBrain: The folder is the full path/.test(relative), `a relative folder is refused: ${relative}`);
  const noTitle = await server.call('databrain_capture', { title: '   ', body: secretBody, folder: realDocs, keywords: ['zebra', 'budget'] });
  assert(/^DataBrain: Provide a note title/.test(noTitle), `an empty title is refused: ${noTitle}`);
  let lines = await callLines();
  assert.deepEqual(lines.map(line => line.replace(/^\d+ms\t/, '')), ['databrain_capture err bad-keywords', 'databrain_capture err bad-keywords', 'databrain_capture err bad-folder', 'databrain_capture err bad-title'], `the log says which kind of refusal each was:\n${lines.join('\n')}`);
  const wholeLog = await fs.readFile(path.join(stateDir, 'stage-timing.log'), 'utf8');
  assert(!/zebra|Zebra|caperrbodymarker|somewhere/.test(wholeLog), 'the log holds no title, note text or folder from a refused call');
  console.log('refused captures log one category word each and no note text: PASS');

  // the plain-word folder: ChatGPT passes "Documents" back
  const bare = await server.call('databrain_capture', { title: secretTitle, body: secretBody, folder: 'Documents', keywords: ['zebra', 'budget'] });
  if (chatgpt) {
    assert(/Saved to: (~|\/[^\n]*)\/Documents\/[^\n]*Zebra budget plan\.md/.test(bare), `ChatGPT: the bare folder name "Documents" saves in the approved Documents folder: ${bare}`);
    console.log('ChatGPT: folder "Documents" (a bare name) saves in the approved Documents folder: PASS');
  } else {
    assert(/^DataBrain: The folder is the full path/.test(bare), `Claude keeps the full-path rule: ${bare}`);
    console.log('Claude: a bare folder name is still refused (full-path rule unchanged): PASS');
  }
  if (chatgpt) await until(async () => (await server.call('databrain_setup_status')).includes('note write: complete'), 'the first note is saved and indexed', 120000);
  const good = await server.call('databrain_capture', { title: 'Second note', body: 'caperrgoodmarker', folder: realDocs, keywords: ['second', 'note'] });
  assert(/Saved to: /.test(good), `a correct call saves: ${good}`);
  lines = await callLines();
  assert(/databrain_capture ok$/.test(lines.at(-1)), `a good call logs ok with no category: ${lines.at(-1)}`);
  console.log('capture err reason: PASS');
} finally { server?.child.kill(); await fs.rm(temp, { recursive: true, force: true }); }
