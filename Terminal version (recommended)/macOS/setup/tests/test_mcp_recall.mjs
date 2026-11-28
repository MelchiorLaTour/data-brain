import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const [engine] = process.argv.slice(2);
assert(engine, 'usage: test_mcp_recall.mjs ENGINE');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-recall-smoke-'));
const corpus = path.join(temp, 'selected-notes');
const moc = path.join(temp, 'moc');
const rootsFile = path.join(temp, 'roots.txt');
await fs.mkdir(corpus);
await fs.mkdir(moc);
const canonicalCorpus = await fs.realpath(corpus);
await fs.writeFile(rootsFile, `${canonicalCorpus}\n`);

const env = {
  ...process.env,
  NB_CANON_ROOTS_FILE: rootsFile,
  NB_MOC_DIR: moc,
  PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
};
function run(script, ...args) {
  const result = spawnSync('/bin/bash', [path.join(engine, 'bin', script), ...args], {
    encoding: 'utf8', env,
  });
  assert.equal(result.status, 0, `${script} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}

try {
  await fs.writeFile(path.join(canonicalCorpus, 'access-review.md'), [
    '---', 'theme: [security]', 'tags: [access-control, synthetic-fixture]', '---',
    '# Access review', 'The fictional Acme team reviews access control before granting a new account permission.', '',
  ].join('\n'));
  await fs.writeFile(path.join(canonicalCorpus, 'archive-backup.md'), [
    '---', 'theme: [operations]', 'tags: [backup, synthetic-fixture]', '---',
    '# Archive backup', 'The fictional Acme team stores a nightly archive backup in a separate location.', '',
  ].join('\n'));

  run('build-index.sh');
  run('build-fts.sh');
  const index = await fs.readFile(path.join(moc, 'index.tsv'), 'utf8');
  assert(index.includes('access-control'), 'user-selected keywords were not recorded in the index');

  const search = query => {
    const result = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), query, '3'], {
      encoding: 'utf8', env,
    });
    assert.equal(result.status, 0, `fts.sh failed for ${query}: ${result.stderr}`);
    return result.stdout;
  };
  const direct = search('access control permission');
  assert(direct.includes('access-review.md'), `direct synthetic query missed its answer-bearing note: ${direct}`);
  const paraphrase = search('granting account permission');
  assert(paraphrase.includes('access-review.md'), `paraphrased synthetic query missed its answer-bearing note: ${paraphrase}`);
  const keyword = search('access-control');
  assert(keyword.includes('access-review.md'), `selected keyword query missed its note: ${keyword}`);
  const absent = search('quasar telescope specimen');
  assert(absent.includes('no matches'), `absent synthetic query did not abstain: ${absent}`);

  console.log('PASS: synthetic direct, paraphrased, and selected-keyword queries retrieve the expected fixture; absent query returns no matches. Plumbing smoke only; not personal held-out recall acceptance.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
