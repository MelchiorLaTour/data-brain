// 0.2.1 part 15: while the first indexing runs, the ChatGPT host's databrain_setup_status carries one line recommending the user turn off
// "Improve the model for everyone" (ChatGPT > Settings > Data controls), and the tool description tells ChatGPT to relay it. The line is a
// labelled fact plus a recommendation (tool results carry facts only). It is absent in the Claude host, and absent once the brain is ready.
// Invented data, fake HOME. The test-only DATABRAIN_TEST_INDEX_DELAY_MS keeps the first indexing running long enough to read the status.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

const NUDGE = 'Recommended for the user: turn off "Improve the model for everyone" in ChatGPT → Settings… → Data controls. While it is on, ChatGPT chats, including the passages DataBrain returns to answer a question, can be used to train OpenAI\'s models. DataBrain cannot change this setting.';
const DELAY = { DATABRAIN_TEST_INDEX_DELAY_MS: '6000' };
const count = (text, needle) => text.split(needle).length - 1;

async function firstIndexing(server, start) {
  await start();
  let during = '';
  await until(async () => { during = await server.tool('databrain_setup_status'); return /Stage: indexing\./.test(during); }, 'the first indexing is running', 60000);
  let ready = '';
  await until(async () => {
    ready = await server.tool('databrain_setup_status');
    if (ready.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await server.tool('databrain_privacy', { action: 'decide', keep: [] });
    return /Stage: ready\./.test(ready);
  }, 'setup reached ready', 240000);
  return { during, ready, again: await server.tool('databrain_setup_status') };
}

const chat = await fakeHome('nudge-chatgpt');
await writeNotes(path.join(chat.home, 'Notes'), { 'Garden.md': '# Garden\nTrellis code 7-Q-41 nudgemarker\n' });
const chatgpt = startChatgpt({ home: chat.home, env: DELAY });
try {
  await chatgpt.initialize();
  const description = (await chatgpt.ask('tools/list', {})).result.tools.find(tool => tool.name === 'databrain_setup_status').description;
  assert(/Repeat lines starting[^.]*"Recommended for the user:"/.test(description) || /line that starts "Recommended for the user:", tell the user that line in plain words/.test(description), `the relay instruction is in the tool description: ${description}`);
  const notes = path.join(chat.home, 'Notes');
  const { during, ready, again } = await firstIndexing(chatgpt, async () => { await chatgpt.tool('databrain_setup_start', { folders: [notes] }); await chatgpt.tool('databrain_setup_start', { folders: [notes], confirmed: true }); });
  assert.equal(count(during, NUDGE), 1, `ChatGPT, first indexing: the recommendation line appears once:\n${during}`);
  assert(during.split('\n').some(line => line === NUDGE), 'it is a line of its own');
  assert(!/Improve the model/.test(ready) && !/Recommended for the user/.test(ready), `ChatGPT, ready: the line is gone:\n${ready}`);
  assert(!/Improve the model/.test(again), 'it does not come back on a later status call');
} finally { await chatgpt.stop(); }

const claude = await fakeHome('nudge-claude');
const claudeNotes = path.join(claude.home, 'Notes');
await writeNotes(claudeNotes, { 'Garden.md': '# Garden\nTrellis code 7-Q-41 nudgemarker\n' });
const old = startChatgpt({ home: claude.home, env: { ...DELAY, DATABRAIN_TEST_CLIENT: 'claude' }, extraArgs: ['--databrain-source-roots', claudeNotes] });
try {
  await old.initialize();
  const description = (await old.ask('tools/list', {})).result.tools.find(tool => tool.name === 'databrain_setup_status').description;
  assert(!/Recommended for the user/.test(description), 'the Claude description has no relay instruction');
  const { during, ready } = await firstIndexing(old, () => old.tool('databrain_setup_start'));
  assert(!/Improve the model|Recommended for the user/.test(during + ready), `Claude host: no recommendation line at any stage:\n${during}`);
} finally { await old.stop(); }
await fs.rm(chat.temp, { recursive: true, force: true });
await fs.rm(claude.temp, { recursive: true, force: true });
console.log('PASS: ChatGPT host: the "Improve the model for everyone" recommendation appears once while the first indexing runs, is relayed by an instruction in the tool description (not in the result), and is gone once ready; the Claude host never shows it.');
