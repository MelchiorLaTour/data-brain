// 0.2.1 part 15: in the ChatGPT host the "not configured" next step must not talk about Claude's extension settings. It was reachable with an
// ordinary fake HOME: the user names folders in the chat, the list is shown, and before the user's yes the status is asked for (the saved
// folder list was then reported as "Extension settings are already saved ... Choosing these in settings is the user's approval").
// Also: a resume note after a restart names ChatGPT, not Claude. Invented data, fake HOME (a normal, non-symlinked one).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, startChatgpt, setupFromChat, writeNotes } from './chatgpt-harness.mjs';

const FORBIDDEN = [/\bClaude\b/i, /extension settings/i, /Claude Desktop/i, /Add directory/i, /Choosing these in settings/i, /in settings\b/i];
const { temp, home, dataHome } = await fakeHome('chatgpt-leak');
assert.equal(await fs.realpath(home), home, 'the fake HOME is not reached through a symbolic link');
const notes = path.join(home, 'Notes');
await writeNotes(notes, { 'Garden.md': '# Garden\nTrellis code 7-Q-41 leakmarker\n' });

const server = startChatgpt({ home });
try {
  await server.initialize();
  // A failed destination job (here: the home folder is read-only, so ~/DataBrain cannot be created) leaves the saved folders and the
  // stage back at "not configured". This is an ordinary home folder, not a symbolic link.
  await fs.chmod(home, 0o555);
  let started;
  try { started = await server.tool('databrain_setup_start', { folders: [notes] }); await new Promise(resolve => setTimeout(resolve, 3000)); } finally { await fs.chmod(home, 0o755); }
  assert(/Creating DataBrain/.test(started), `setup was started:\n${started}`);
  const status = await server.tool('databrain_setup_status');
  assert(/Stage: not configured\./.test(status), `setup did not get past the failed destination job:\n${status}`);
  assert(/destination selection: failed/.test(status), `the destination job failed:\n${status}`);
  const bad = FORBIDDEN.filter(pattern => pattern.test(status));
  assert.deepEqual(bad.map(String), [], `the not-configured status names Claude's settings:\n${status}`);
  assert(/Setup has not started\. The chat named 1 folder\(s\): .*Ask the user which folders to read, then call databrain_setup_start with them\./.test(status), `ChatGPT's own next step:\n${status}`);
  await fs.rm(path.join(home, 'DataBrain'), { recursive: true, force: true });

  // a resume note after a restart
  await setupFromChat(server, [notes]);
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  await fs.writeFile(statePath, `${JSON.stringify({ ...state, resumeNote: { at: new Date().toISOString() } }, null, 2)}\n`);
  const resumed = await server.tool('databrain_setup_status');
  assert(/Indexing was interrupted when ChatGPT restarted and resumed by itself/.test(resumed), `the resume note names ChatGPT:\n${resumed}`);
  assert.deepEqual(FORBIDDEN.filter(pattern => pattern.test(resumed)).map(String), [], `the resume status names Claude:\n${resumed}`);
} finally { await server.stop(); }
await fs.rm(temp, { recursive: true, force: true });
console.log('PASS: ChatGPT host: the not-configured status (reached with an ordinary fake HOME) gives ChatGPT its own next step and never says "extension settings"; the resume note names ChatGPT.');
