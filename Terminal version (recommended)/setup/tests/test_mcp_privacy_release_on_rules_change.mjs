// Part 40 (0.2.1): a brain screened by the older privacy rules is screened again by the new ones, and files the old rules held for their TEXT come back
// when the new rules find nothing private. A note and a Word file the old rules held ("Code: Python", "first pass: ...") are indexed again; a note and a
// Word file holding a real password are held again; a name hold and the user's own exclude decision are untouched. Invented data, fake HOME.
// Usage: node test_mcp_privacy_release_on_rules_change.mjs [claude|chatgpt]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, initialize, setupToReady, sleep, startServer, until } from './mcp-harness-0138.mjs';
import { setupFromChat, startChatgpt } from './chatgpt-harness.mjs';

const hostName = process.argv[2] || 'claude';
const NEW_RULES = '0.2.1-part40';
const { home, docs, dataHome, statePath } = await fakeHome(`p40release-${hostName}`);
const privacyPath = path.join(dataHome, '.databrain', 'privacy.tsv');
const state = async () => JSON.parse(await fs.readFile(statePath, 'utf8'));
const rows = async () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').catch(() => '');
const finalStatus = async () => {
  const last = new Map();
  for (const line of (await fs.readFile(privacyPath, 'utf8')).split('\n').filter(Boolean)) { const [status, file, why] = line.split('\t'); last.set(path.basename(file), { status, why }); }
  return last;
};
const start = () => hostName === 'chatgpt' ? startChatgpt({ home }) : startServer({ home, roots: [docs] });
const begin = async server => { if (hostName === 'chatgpt') await server.initialize(); else await initialize(server); };

await fs.writeFile(path.join(docs, 'base.md'), '# Base\np40releasebase garden notes.\n');
let server = start();
try {
  await begin(server);
  if (hostName === 'chatgpt') await setupFromChat(server, [docs]); else await setupToReady(server);

  // files the OLD rules held for their text, written into the held list the way an older version left it
  const files = {
    'group-plan.md': '# Group 12 research plan\np40releaseordinary Code: Python, with pandas for the models.\nFor the first pass: read the abstract.\n',
    'wifi-note.md': '# Home\np40releasesecret Password: hunter2\n',
    'excluded-by-me.md': '# Draft\np40releaseexcluded Code: R for the cleaning.\n',
    'passport-copy.md': '# Trip\np40releasename nothing else here.\n',
  };
  for (const [name, text] of Object.entries(files)) await fs.writeFile(path.join(docs, name), text);
  for (const [name, text] of Object.entries({ 'meeting.docx': 'p40releasedocordinary Code: Python for the dashboard. First pass: tidy the data.', 'vault.docx': 'p40releasedocsecret mot de passe : Soleil2019' })) {
    const txt = path.join(home, `${name}.txt`);
    await fs.writeFile(txt, text);
    execFileSync('/usr/bin/textutil', ['-convert', 'docx', '-output', path.join(docs, name), txt]);
    await fs.rm(txt);
  }
  const T = '\t';
  await fs.appendFile(privacyPath, [
    `held${T}${path.join(docs, 'group-plan.md')}${T}contains a password`,
    `held${T}${path.join(docs, 'wifi-note.md')}${T}contains a password`,
    `held${T}${path.join(docs, 'meeting.docx')}${T}contains a password`,
    `held${T}${path.join(docs, 'vault.docx')}${T}contains a password`,
    `excluded${T}${path.join(docs, 'excluded-by-me.md')}${T}contains a password`,
    `held${T}${path.join(docs, 'passport-copy.md')}${T}name "passport" looks private`,
  ].join('\n') + '\n');
  await fs.writeFile(statePath, JSON.stringify({ ...(await state()), privacyRulesVersion: '0.1.38' }, null, 2));   // screened by the older rules

  // a new server start begins the one-time re-check by itself
  server.child.kill('SIGTERM'); await sleep(800);
  server = start();
  await begin(server);
  await server.tool('databrain_search', { query: 'p40releaseordinary' });   // a question while the re-check is due starts it too
  await until(async () => (await state()).privacyRulesVersion === NEW_RULES, 'the re-check under the new rules finished', 300000);

  const index = await rows();
  const held = await finalStatus();
  assert(index.includes('group-plan.md') && !held.has('group-plan.md'), `a note the old rules held for "Code: Python" is indexed again:\n${index}`);
  assert(index.includes('meeting.docx') && !held.has('meeting.docx'), `a Word file the old rules held for "Code: Python" is indexed again:\n${index}`);
  assert.deepEqual(held.get('wifi-note.md'), { status: 'held', why: 'contains a password' }, 'a note with a real password is held again');
  assert.deepEqual(held.get('vault.docx'), { status: 'held', why: 'contains a password' }, 'a Word file with a real password is held again');
  assert(!index.includes('wifi-note.md') && !index.includes('vault.docx'), 'held files are not in the index');
  assert.deepEqual(held.get('excluded-by-me.md'), { status: 'excluded', why: 'contains a password' }, "the user's exclude decision stays");
  assert.equal(held.get('passport-copy.md')?.status, 'held', 'a name hold stays');
  assert(!index.includes('excluded-by-me.md') && !index.includes('passport-copy.md'), 'excluded and name-held files stay out of the index');
  assert((await server.tool('databrain_search', { query: 'p40releaseordinary' })).includes('group-plan.md'), 'the released note answers a search');
  assert(!(await server.tool('databrain_search', { query: 'p40releasesecret' })).includes('wifi-note.md'), 'the re-held note does not');
  console.log(`PASS (${hostName}): after a rules change, files held for their text are screened again: ordinary ones come back, real secrets stay held; name holds and user decisions are untouched`);
} finally {
  server.child.kill('SIGTERM');
  await sleep(500);
}
