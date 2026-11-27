// 0.1.38: privacy rules against real-world note shapes (all text invented). A college login note (email + a short mixed token, no
// label), short password labels and a real card with a card word are held and leave the index; a textbook table whose numbers pass the
// card checksum by chance, and an ordinary note, stay indexed. After a refresh the rules version is recorded (one full re-screen).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, initialize, setupToReady, sleep, startServer, until } from './mcp-harness-0138.mjs';

const { temp, home, docs, dataHome, statePath } = await fakeHome('privacy-shapes');
const files = {
  'college-email.md': '# College email\nsample.person@example.edu\n\nnotes for the portal\nc014d1\n',
  'short-labels.md': '# Accounts\nusername: jane.roe42\npwd = zeta99\npin: 4821\n',
  'card.md': '# Wallet\nVisa card 4111 1111 1111 1111 exp 12/29\n',
  'textbook.md': '# Statistics table\nvalues 4111111111111111 5555555555554444 378282246310005 6011111111111117 as raw data\n',
  'ordinary.md': '# Garden\nprivacyshapesmarker tomatoes need staking in June.\n',
};
for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(docs, name), text);
const server = startServer({ home, roots: [docs] });
const { child, tool } = server;
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const index = async () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');

try {
  await initialize(server);
  await setupToReady(server);
  const rows = await index();
  for (const held of ['college-email.md', 'short-labels.md', 'card.md']) assert(!rows.includes(held), `${held} must be held and out of the index:\n${rows}`);
  for (const kept of ['textbook.md', 'ordinary.md']) assert(rows.includes(kept), `${kept} must stay indexed:\n${rows}`);
  assert(!(await tool('databrain_search', { query: 'c014d1' })).includes('college-email.md'), 'held text is not searchable');

  // a refresh records the rules version (the one-time full re-screen ran)
  const before = await state();
  delete before.privacyRulesVersion;
  await fs.writeFile(statePath, JSON.stringify(before, null, 2));
  await fs.writeFile(path.join(docs, 'ordinary.md'), '# Garden\nprivacyshapesmarker tomatoes need staking in July.\n');
  await tool('databrain_refresh');
  await until(async () => (await state()).privacyRulesVersion === '0.1.38', 'rules version recorded after a refresh', 120000);
  assert((await index()).includes('ordinary.md'), 'the ordinary note is still indexed after the re-screen');
  console.log('PASS: login pair, short labels and a card with a card word are held; chance-Luhn tables and ordinary notes stay; the rules version is recorded after a refresh');
} finally {
  child.kill('SIGTERM');
  await sleep(500);
  await fs.rm(temp, { recursive: true, force: true }).catch(() => {});
}
