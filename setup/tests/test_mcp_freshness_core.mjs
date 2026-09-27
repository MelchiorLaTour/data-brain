import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const { captureFreshnessBaseline, checkFreshness, scanSelectedFiles } = await import(pathToFileURL(path.join(engine, 'setup/mcp/freshness-core.mjs')));

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-freshness-'));
const requestedRoot = path.join(temp, 'selected');
await fs.mkdir(requestedRoot);
const root = await fs.realpath(requestedRoot);
const a = path.join(root, 'a.md');
const b = path.join(root, 'b.txt');
const missing = path.join(root, 'gone.md');
await fs.writeFile(a, 'synthetic one');
await fs.writeFile(b, 'synthetic two');
await fs.mkdir(path.join(root, '.git'));
await fs.writeFile(path.join(root, '.git', 'excluded.md'), 'not scanned');
await fs.mkdir(path.join(root, 'Resources', 'Sensitive'), { recursive: true });
await fs.writeFile(path.join(root, 'Resources', 'Sensitive', 'credential.md'), 'must not be scanned');
const index = `${a}\tA\t-\t-\n${b}\tB\t-\t-\n${missing}\tGone\t-\t-\n`;
const inventory = `${a}\tindexed\tpresent\n${b}\tindexed\tpresent\n`;
const baseline = await captureFreshnessBaseline({ roots: [root], indexText: index });

const clean = await checkFreshness({ roots: [root], indexText: index, inventoryText: inventory, baselineText: baseline });
assert.deepEqual(clean, { stale: true, added: [], deleted: [missing], changed: [], untracked: [] });

// Re-baseline only currently indexed paths to isolate each change type.
const currentIndex = `${a}\tA\t-\t-\n${b}\tB\t-\t-\n`;
const currentBaseline = await captureFreshnessBaseline({ roots: [root], indexText: currentIndex });
const currentInventory = `${a}\tindexed\tpresent\n${b}\tindexed\tpresent\n`;
assert.deepEqual(await checkFreshness({ roots: [root], indexText: currentIndex, inventoryText: currentInventory, baselineText: currentBaseline }), {
  stale: false, added: [], deleted: [], changed: [], untracked: [],
});
assert.deepEqual(await scanSelectedFiles({ roots: [root] }), [a, b]);

await fs.writeFile(a, 'synthetic one changed');
assert.deepEqual(await checkFreshness({ roots: [root], indexText: currentIndex, inventoryText: currentInventory, baselineText: currentBaseline }), {
  stale: true, added: [], deleted: [], changed: [a], untracked: [],
});

await fs.writeFile(path.join(root, 'new.md'), 'synthetic new');
const withAddition = `${currentInventory}${path.join(root, 'new.md')}\tmissing_index\tpresent\n`;
assert.deepEqual(await checkFreshness({ roots: [root], indexText: currentIndex, inventoryText: withAddition, baselineText: currentBaseline }), {
  stale: true, added: [path.join(root, 'new.md')], deleted: [], changed: [a], untracked: [],
});

const symlink = path.join(root, 'linked.md');
const outside = path.join(temp, 'outside.md');
await fs.writeFile(outside, 'outside sentinel');
await fs.symlink(outside, symlink);
assert(!(await scanSelectedFiles({ roots: [root] })).includes(outside), 'the selected-root scan followed a symlink outside its grant');
const linkBaseline = await captureFreshnessBaseline({ roots: [root], indexText: `${symlink}\tLinked\t-\t-\n` });
assert.match(linkBaseline, /missing$/m);
const outsideIndex = await checkFreshness({ roots: [root], indexText: `${outside}\tOutside\t-\t-\n`, inventoryText: `${outside}\tindexed\tpresent\n`, baselineText: currentBaseline });
assert(!outsideIndex.added.includes(outside) && !outsideIndex.changed.includes(outside), 'out-of-grant paths must not enter freshness results');
assert.deepEqual(await checkFreshness({ roots: [root], indexText: '', inventoryText: '', baselineText: `# databrain-source-freshness-v1\n${encodeURIComponent(outside)}\t1\t2\t3\t4\t5\n` }), {
  stale: false, added: [], deleted: [], changed: [], untracked: [],
});

const alternateRoot = path.join(temp, 'alias');
await fs.symlink(root, alternateRoot);
await assert.rejects(captureFreshnessBaseline({ roots: [alternateRoot], indexText: currentIndex }), /canonical absolute|unavailable|identity/i);
await assert.rejects(captureFreshnessBaseline({ roots: [path.join(temp, 'Resources', 'Sensitive')], indexText: '' }), /Sensitive credential roots/);

console.log('PASS: freshness metadata detects added, deleted, and changed indexed files without opening file contents; rejects unapproved, symlinked, and sensitive roots.');
await fs.rm(temp, { recursive: true, force: true });
