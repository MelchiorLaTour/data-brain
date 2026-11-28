// Part 18 B and C (0.2.1). B: databrain_capture has a plain title in the ChatGPT host only. C: the ChatGPT description of databrain_search carries the
// "find my ..." sentence; the Claude description does not. C is a separate block on purpose: if Mel says no to C, delete block C here and the one phrase-table
// entry in server.mjs marked "Part 18 C". Run with DATABRAIN_TEST_CLIENT=claude and chatgpt.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const chatgpt = process.env.DATABRAIN_TEST_CLIENT === 'chatgpt';
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const home = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-title-routing-'));
const child = spawn(process.execPath, [serverScript, ...(chatgpt ? ['--databrain-client', 'chatgpt'] : [])], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'ignore'] });
const waiting = new Map(); let n = 0;
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
try {
  await ask('initialize', { protocolVersion: '2025-03-26' });
  const tools = (await ask('tools/list', {})).result.tools;
  const tool = name => tools.find(t => t.name === name);

  // ---- B: the capture title
  if (chatgpt) assert.equal(tool('databrain_capture').title, 'Save a note to my notes', 'ChatGPT: databrain_capture has the plain title');
  else assert.equal(tool('databrain_capture').title, undefined, 'Claude: databrain_capture has no title (unchanged)');
  assert.equal(tool('databrain_search').title, 'Search my notes, documents, reminders and files', 'the search title is unchanged in both hosts');

  // ---- C: the "find my ..." sentence (separable)
  const search = tool('databrain_search').description;
  const SENTENCE = /for "find my …", "where is my …", "my login for …", "check my files", "in DataBrain", "look it up": call this FIRST, before saying you do not know and before asking where something is kept, even when the topic is private \(DataBrain keeps private files out of results itself\)/;   // Part 25: shortened with the ChatGPT tool list; same rule
  if (chatgpt) assert(SENTENCE.test(search) && search.length <= 4000, `ChatGPT: the search description carries the sentence and stays within 4000 characters (${search.length})`);
  else assert(!/find my …/.test(search), 'Claude: the search description does not carry the sentence');
  assert(!/find my …/.test(tool('databrain_abstain_check').description), 'the sentence is only on databrain_search');
  console.log(`PASS: capture title and "find my" sentence as expected for the ${chatgpt ? 'ChatGPT' : 'Claude'} host (search description ${search.length} characters)`);
} finally { child.kill(); await fs.rm(home, { recursive: true, force: true }); }
