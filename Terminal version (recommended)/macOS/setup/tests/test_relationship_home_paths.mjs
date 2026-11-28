import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const engine = path.resolve(process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-home-relationships-')));
const home = path.join(temp, 'home');
const root = path.join(home, 'Documents');
const moc = path.join(temp, 'brain', 'moc');
await fs.mkdir(root, { recursive: true });
await fs.mkdir(moc, { recursive: true });
const first = path.join(root, 'overview.md');
const second = path.join(root, 'details.md');
await fs.writeFile(first, '# Overview\n\n[Details](details.md)\n');
await fs.writeFile(second, '# Details\n\nApproved fixture body.\n');
await fs.writeFile(path.join(moc, 'index.tsv'), [
  '# canonical_path\ttitle\tthemes\tkeywords',
  '~/Documents/overview.md\tOverview\twork\talpha',
  '~/Documents/details.md\tDetails\twork\tbeta',
  '',
].join('\n'));
const rootsFile = path.join(temp, 'roots.txt');
await fs.writeFile(rootsFile, `${root}\n`);
const before = await Promise.all([first, second].map(async file => (await fs.readFile(file)).toString()));
const run = spawnSync('/bin/bash', [path.join(engine, 'bin', 'relationships.sh')], {
  encoding: 'utf8',
  env: { ...process.env, HOME: home, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: rootsFile },
});
assert.equal(run.status, 0, `relationship report failed: ${run.stderr}`);
assert.match(run.stdout, /Relationship report saved for 2 indexed rows/);
assert.match(run.stdout, /Explicit local Markdown links: 1/);
const report = await fs.readFile(path.join(moc, 'relationships.tsv'), 'utf8');
assert(report.includes(encodeURIComponent(first)), 'tilde-indexed home path was absent from terminal relationship report');
assert(report.includes(encodeURIComponent(second)), 'second tilde-indexed home path was absent from terminal relationship report');
const after = await Promise.all([first, second].map(async file => (await fs.readFile(file)).toString()));
assert.deepEqual(after, before, 'relationship indexing changed source documents');
const { markdownLinkTargets, wikiNameIndex } = await import('../mcp/relationship-core.mjs');
const names = wikiNameIndex(['/v/a/Note One.md', '/v/b/other.md', '/v/c/other.md', '/v/d/scan.pdf']);
assert.deepEqual(markdownLinkTargets('see [[Note One|alias]], [[other]], ![[scan.pdf]] and [[missing]]', '/v/x.md', names),
  ['/v/a/Note One.md', '/v/d/scan.pdf']);
console.log('PASS: terminal relationship scan expands normal ~/ index paths, records links, and leaves originals unchanged.');
await fs.rm(temp, { recursive: true, force: true });
