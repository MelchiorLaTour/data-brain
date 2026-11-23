// Part 19 (0.2.1): a file the ingest pass leaves out twice in a row, unchanged, is parked (it stops making the index stale); once is not enough; a change
// of size or modification time un-parks it. Pure helpers from freshness-core.mjs, invented files in a temp folder.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = process.env.DATABRAIN_SERVER ? path.dirname(process.env.DATABRAIN_SERVER) : path.join(here, '../mcp');
const { parkedAmong, recordLeftOut } = await import(pathToFileURL(path.join(engine, 'freshness-core.mjs')).href);
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-leftout-')));
try {
  const list = path.join(temp, 'left-out.json');
  const a = path.join(temp, 'a.md'); const b = path.join(temp, 'b.md');
  await fs.writeFile(a, 'first'); await fs.writeFile(b, 'second');
  const parked = async () => [...await parkedAmong(list, [a, b])].map(file => path.basename(file)).sort();

  assert.deepEqual(await parked(), [], 'nothing is parked before any pass');
  await recordLeftOut(list, [a]);
  assert.deepEqual(await parked(), [], 'left out ONCE (a real change while it was read): not parked, the next pass tries again');
  await recordLeftOut(list, [a, b]);
  assert.deepEqual(await parked(), ['a.md'], 'left out twice in a row, unchanged: parked; b was only left out once');
  await recordLeftOut(list, [a, b]);
  assert.deepEqual(await parked(), ['a.md', 'b.md'], 'b is parked on its second time too');

  await fs.writeFile(a, 'first, edited');
  assert.deepEqual(await parked(), ['b.md'], 'a changed size: it is tried again (no longer parked)');
  await recordLeftOut(list, [a]);
  assert.deepEqual(await parked(), ['b.md'], 'after the change a is back to one pass left out: not parked');
  await recordLeftOut(list, [a]);
  assert.deepEqual(await parked(), ['a.md', 'b.md'], 'and parked again if the new version fails twice');

  await fs.rm(b);
  assert.deepEqual(await parked(), ['a.md'], 'a deleted file is not parked (nothing to park)');
  assert.deepEqual([...await parkedAmong(path.join(temp, 'missing.json'), [a])], [], 'no list file: nothing parked');
  console.log('PASS: a file left out twice in a row and unchanged is parked; once is not enough; a change un-parks it');
} finally { await fs.rm(temp, { recursive: true, force: true }); }
