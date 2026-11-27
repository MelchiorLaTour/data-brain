// Part 16 (0.2.1), item A: saving a note. In ChatGPT the tool description tells the model to ask where to save BEFORE saving and to tell the user the
// full place AFTER; the result carries the place as a labelled fact ("Saved to: <full path>"). The Claude description is unchanged, but its result
// carries the same labelled line. Invented data, fake HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, startChatgpt, setupFromChat, until, writeNotes } from './chatgpt-harness.mjs';

const ASK = /BEFORE calling, ask (the user )?where to save it \(name the approved folders in plain words[^)]*\) unless [^.]*\bdefault is set[;.] (do not save without that answer\. )?AFTER saving, tell the user the full place from the line that starts "Saved to:"/;   // part 25b: the slimmed ChatGPT text keeps both rules, in fewer words
const NAMES = ['databrain_capture', 'databrain_file_note', 'databrain_save_synthesis'];
async function run(client) {
  const { temp, home } = await fakeHome(`note-ask-${client}`);
  const notes = path.join(home, 'Notes'); await writeNotes(notes, { 'Garden.md': '# Garden\nasknotemarker tomatoes.\n' });
  const server = client === 'chatgpt' ? startChatgpt({ home }) : startChatgpt({ home, env: { DATABRAIN_TEST_CLIENT: 'claude' }, extraArgs: ['--databrain-source-roots', notes] });
  try {
    await server.initialize();
    const tools = (await server.ask('tools/list', {})).result.tools;
    for (const name of NAMES) {
      const description = tools.find(tool => tool.name === name).description;
      if (client === 'chatgpt') assert(ASK.test(description), `ChatGPT: ${name} tells the model to ask where first and to say where after`);
      else assert(!/BEFORE calling, ask the user where to save/.test(description), `Claude: ${name} description is unchanged`);
    }
    if (client === 'chatgpt') await setupFromChat(server, [notes]);
    else { await server.tool('databrain_setup_start'); await until(async () => /Stage: ready\./.test(await server.tool('databrain_setup_status')), 'ready', 240000); }
    const folder = await fs.realpath(notes);
    const reply = await server.tool('databrain_capture', { title: 'Ask first note', body: 'asknotebody remember the oat milk', keywords: ['asknote', 'oat'], folder });
    const saved = reply.match(/^Saved to: (.+)$/m);
    assert(saved, `${client}: the result carries "Saved to: <path>":\n${reply}`);
    const shown = saved[1].replace(/^~/, home);   // paths shown to the model never carry the home folder name
    assert(shown.startsWith(folder) && /Ask first note\.md$/.test(shown), `${client}: it is the full path of the new file: ${saved[1]}`);
    await fs.access(shown);
  } finally { await server.stop(); await fs.rm(temp, { recursive: true, force: true }); }
}
await run('chatgpt'); await run('claude');
console.log('PASS: ChatGPT tells the model to ask where to save first and to say where after (Claude description unchanged); both hosts return "Saved to: <full path>" for a saved note.');
