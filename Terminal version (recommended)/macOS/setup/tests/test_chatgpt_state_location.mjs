// 0.2.1: a ChatGPT plugin lives in a versioned cache (~/.codex/plugins/cache/<marketplace>/<plugin>/<version>/) that an update replaces,
// so the server must keep ALL user state in the DataBrain folder and write nothing next to its own files or anywhere else in the home
// folder. A full journey (setup, search, capture, refresh, repair, restart) runs in a fake HOME; the engine files must be byte-identical
// afterwards and every new file must sit inside the DataBrain folder or an approved source folder.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, here, setupFromChat, startChatgpt, until, writeNotes } from './chatgpt-harness.mjs';

async function tree(dir, prefix = '') {
  const out = {};
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = path.join(prefix, entry.name);
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(out, await tree(full, rel));
    else if (entry.isFile()) out[rel] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
    else out[rel] = entry.isSymbolicLink() ? 'symlink' : 'other';
  }
  return out;
}

const engineRoot = path.resolve(here, '../..');
const engineDirs = ['setup/mcp', 'bin'];
const before = {};
for (const dir of engineDirs) before[dir] = await tree(path.join(engineRoot, dir));

const { temp, home, dataHome } = await fakeHome('chatgpt-state');
const notes = path.join(home, 'Notes');
await writeNotes(notes, { 'Garden.md': '# Garden\nTrellis code 7-Q-41 statemarker\n', 'Trip.md': '# Trip\nPlatform 6 statemarker\n' });
const homeBefore = await tree(home);
let server = startChatgpt({ home });
try {
  await server.initialize();
  await setupFromChat(server, [notes]);
  assert(/Garden/.test(await server.tool('databrain_search', { query: 'trellis' })));
  await server.tool('databrain_capture', { title: 'Rope idea', body: 'An invented note about buying rope.', keywords: ['rope', 'idea'], folder: notes });
  await until(async () => (await server.tool('databrain_setup_status')).includes('note write: complete'), 'note saved');
  await server.tool('databrain_refresh');
  await server.tool('databrain_repair');
  await server.stop();
  server = startChatgpt({ home });
  await server.initialize();
  assert(/Stage: ready\./.test(await server.tool('databrain_setup_status')));
  await server.tool('databrain_diagnostics');
} finally {
  await server.stop();
}

for (const dir of engineDirs) assert.deepEqual(await tree(path.join(engineRoot, dir)), before[dir], `${dir} changed while the server ran: user state must not be written next to the server files`);
const homeAfter = await tree(home);
const created = Object.keys(homeAfter).filter(file => !(file in homeBefore));
const stray = created.filter(file => !file.startsWith('DataBrain/') && !file.startsWith('Notes/'));
assert.deepEqual(stray, [], `files written outside the DataBrain folder and the approved folders: ${stray.join(', ')}`);
assert(created.some(file => file.startsWith('DataBrain/.databrain/')), 'the saved state is inside the DataBrain folder');
void dataHome;
console.log(`PASS: ChatGPT host state location: after setup, search, capture, refresh, repair and a restart, ${engineDirs.join(' and ')} are byte-identical (${Object.keys(before['setup/mcp']).length + Object.keys(before.bin).length} files compared) and all ${created.length} new files sit inside the DataBrain folder or an approved folder.`);
await fs.rm(temp, { recursive: true, force: true });
