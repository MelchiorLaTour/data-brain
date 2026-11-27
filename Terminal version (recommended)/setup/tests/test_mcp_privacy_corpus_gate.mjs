// Part 40 standing gate, app hosts: the invented corpus (privacy-corpus/) goes through a real setup in a fake HOME. No ordinary document may be held
// (each is indexed), and every real secret is held for its text and kept out of the index. Usage: node test_mcp_privacy_corpus_gate.mjs [claude|chatgpt]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fakeHome, here, initialize, setupToReady, sleep, startServer } from './mcp-harness-0138.mjs';
import { setupFromChat, startChatgpt } from './chatgpt-harness.mjs';

const hostName = process.argv[2] || 'claude';
const { home, docs, dataHome } = await fakeHome(`p40corpus-${hostName}`);
execFileSync('/bin/bash', [path.join(here, 'privacy-corpus', 'build.sh'), docs]);
const ordinary = await fs.readdir(path.join(docs, 'everyday'));
const secrets = await fs.readdir(path.join(docs, 'vaultish'));
assert(ordinary.length >= 60 && secrets.length >= 25, 'the corpus has at least 60 ordinary documents and 25 secrets');
const server = hostName === 'chatgpt' ? startChatgpt({ home }) : startServer({ home, roots: [docs] });
try {
  if (hostName === 'chatgpt') { await server.initialize(); await setupFromChat(server, [docs], { limit: 400000 }); }
  else { await initialize(server); await setupToReady(server); }
  const last = new Map();
  for (const line of (await fs.readFile(path.join(dataHome, '.databrain', 'privacy.tsv'), 'utf8').catch(() => '')).split('\n').filter(Boolean)) {
    const [status, file, why] = line.split('\t'); last.set(file, { status, why });
  }
  const index = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  const wrongHeld = ordinary.filter(name => last.has(path.join(docs, 'everyday', name)));
  const notIndexed = ordinary.filter(name => !index.includes(`everyday/${name}`));
  const missed = secrets.filter(name => { const entry = last.get(path.join(docs, 'vaultish', name)); return !entry || !/^(?:contains |looks like )/.test(entry.why); });
  const leaked = secrets.filter(name => index.includes(`vaultish/${name}`));
  console.log(`${hostName}: ordinary ${ordinary.length}, held ${wrongHeld.length}, not indexed ${notIndexed.length}; secrets ${secrets.length}, missed ${missed.length}, in index ${leaked.length}`);
  assert.deepEqual(wrongHeld, [], 'no ordinary document is held');
  assert.deepEqual(notIndexed, [], 'every ordinary document is indexed');
  assert.deepEqual(missed, [], 'every real secret is held for its text');
  assert.deepEqual(leaked, [], 'no real secret is in the index');
  console.log(`PASS (${hostName}): corpus gate: 0 ordinary documents held, every real secret held`);
} finally {
  server.child.kill('SIGTERM');
  await sleep(500);
}
