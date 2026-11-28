// 0.2.1 parity: the same invented notes and the same questions answered by the Claude host and the ChatGPT host. The facts in the results
// (which notes, in which order, with which excerpt, the text a read returns, and whether an absent question abstains) must be identical.
// Host words and the way the folders arrive are the only differences, and they are not in these results.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, setupFromChat, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

const NOTES = {
  'Trip to Brettamoor.md': '# Trip to Brettamoor\nThe train leaves Thursday at 08:12 from platform 6. Bring the blue ticket.\n',
  'Ember tart.md': '# Ember tart\nBake the ember tart for 34 minutes at 180 C. Rest it ten minutes.\n',
  'Garden plan.md': '# Garden plan\nThe trellis code is 7-Q-41. Plant the beans along the east wall in May.\n',
  'Violin lessons.md': '# Violin lessons\nLessons are on Tuesday at 17:30 with Madame Orsolya. Bring the green folder.\n',
  'Harbor notes.md': '# Harbor notes\nThe harbor ferry leaves at 09:05 from pier 3. The platform for the train is 6.\n',
};
const QUESTIONS = ['train Brettamoor Thursday', 'ember tart minutes', 'trellis code', 'violin lessons Tuesday', 'platform 6', 'ferry pier', 'zzqxunmatched zzqxabsent'];

async function run(host) {
  const { temp, home } = await fakeHome(`parity-${host}`);
  const notes = path.join(home, 'Notes');
  await writeNotes(notes, NOTES);
  const server = host === 'chatgpt' ? startChatgpt({ home }) : startChatgpt({ home, extraArgs: ['--databrain-source-roots', notes] });
  const out = { search: [], read: [], abstain: null };
  try {
    await server.initialize();
    if (host === 'chatgpt') await setupFromChat(server, [notes]);
    else { await server.tool('databrain_setup_start'); await until(async () => /Stage: ready\./.test(await server.tool('databrain_setup_status')), 'ready', 240000); }
    for (const question of QUESTIONS) out.search.push(await server.tool('databrain_search', { query: question }));
    const firstPath = (out.search[0].match(/^From your files: (\S.*)$/m) || [])[1];
    out.read.push(await server.tool('databrain_read', { path: firstPath }));
    out.read.push(await server.tool('databrain_read', { path: firstPath, offset: 30, chars: 100 }));
    out.abstain = await server.tool('databrain_abstain_check', { queries: ['train Brettamoor', 'Thursday train platform'] });
    out.absent = await server.tool('databrain_abstain_check', { queries: ['zzqxunmatched', 'zzqxabsent'] });
  } finally {
    await server.stop();
    await fs.rm(temp, { recursive: true, force: true });
  }
  return out;
}

const claude = await run('claude');
const chatgpt = await run('chatgpt');
assert.equal(claude.search.length, QUESTIONS.length);
for (const [index, question] of QUESTIONS.entries()) assert.equal(chatgpt.search[index], claude.search[index], `search results differ between hosts for "${question}"`);
assert.deepEqual(chatgpt.read, claude.read, 'read results differ between hosts');
assert.equal(chatgpt.abstain, claude.abstain, 'abstain_check results differ between hosts');
assert.equal(chatgpt.absent, claude.absent, 'the absent question must abstain the same way in both hosts');
assert(/DRY/.test(claude.absent) && /DRY/.test(chatgpt.absent), 'the absent question is DRY in both hosts');
assert(/08:12/.test(claude.read[0]) && /08:12/.test(chatgpt.read[0]), 'the read returns the invented fact');
console.log(`PASS: parity: ${QUESTIONS.length} questions, 2 reads and 2 abstain checks give identical results in the Claude host and the ChatGPT host (the absent question is DRY in both).`);
