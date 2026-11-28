// The freshness scan must skip the same credential folders as the engine walker (bin/canon.sh PRUNE_DIRS).
// Usage: node test_mcp_freshness_credential_dirs.mjs [engine-root]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-credential-dirs-'));
const root = await fs.realpath(temp);
const names = ['normal.md', '.ssh/synthetic.md', '.gnupg/synthetic.md', '.aws/synthetic.md', 'deep/.ssh/synthetic.md', 'deep/keep.md'];
for (const name of names) {
  const file = path.join(root, name);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'Synthetic fixture only.\n');
}
const relative = files => files.map(f => path.relative(root, f).split(path.sep).join('/')).sort();
const expected = ['deep/keep.md', 'normal.md'];

const real = await import(pathToFileURL(path.join(engine, 'setup/mcp/freshness-core.mjs')));
assert.deepEqual(relative(await real.scanSelectedFiles({ roots: [root] })), expected);

// Mutant: remove the three credential names from the exclusion list; the same check must now fail.
const source = await fs.readFile(path.join(engine, 'setup/mcp/freshness-core.mjs'), 'utf8');
const mutated = source.replace(", '.ssh', '.gnupg', '.aws',", ',');
assert.notEqual(mutated, source, 'mutant did not apply: exclusion list text changed');
const mutantFile = path.join(path.dirname(path.join(engine, 'setup/mcp/freshness-core.mjs')), `.mutant-freshness-${process.pid}.mjs`);
await fs.writeFile(mutantFile, mutated);
try {
  const mutant = await import(pathToFileURL(mutantFile));
  const found = relative(await mutant.scanSelectedFiles({ roots: [root] }));
  assert.notDeepEqual(found, expected, 'mutant survived: test cannot detect missing credential exclusions');
  assert(found.includes('.ssh/synthetic.md'));
} finally {
  await fs.rm(mutantFile, { force: true });
  await fs.rm(temp, { recursive: true, force: true });
}
console.log('freshness credential-dir exclusions OK (mutant killed)');
