import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inspectCodexSetupRecovery, readCodexLocator, writeCodexLocator, writeCodexSetupMarker } from '../mcp/codex-state.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'databrain-codex-state-'));
try {
  const home = path.join(await realpath(temp), 'home');
  const destination = path.join(home, 'Desktop', 'DataBrain');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  assert.equal(readCodexLocator({ home }).status, 'missing');

  const pending = path.join(home, 'Desktop', 'Interrupted DataBrain');
  await mkdir(pending, { mode: 0o700 });
  assert.deepEqual(await inspectCodexSetupRecovery(pending), { recoverable: true, needsMarker: true, staleTemps: [] });
  writeCodexSetupMarker(pending);
  assert.equal((await lstat(path.join(pending, '.databrain-codex-setup-pending'))).mode & 0o777, 0o600);
  await writeFile(path.join(pending, '.source-roots'), `${home}\n`, { mode: 0o600 });
  await mkdir(path.join(pending, '.databrain'), { mode: 0o700 });
  await writeFile(path.join(pending, '.databrain', 'root-identities.tsv'), `${home}\t1:2\n`, { mode: 0o600 });
  await writeFile(path.join(pending, '.databrain', 'index-worker-lock.sqlite'), '', { mode: 0o600 });
  await writeFile(path.join(pending, '.databrain', 'index-worker-lock.sqlite-journal'), '', { mode: 0o600 });
  const pendingInfo = await lstat(pending);
  const scopeMarker = path.join(pending, '.databrain', 'codex-scope-commit-pending.tsv');
  const scopeMarkerText = [
    'schema=databrain-codex-scope-commit-v1',
    `destination=${pending}`,
    `device=${pendingInfo.dev}`,
    `inode=${pendingInfo.ino}`,
    '',
  ].join('\n');
  await writeFile(scopeMarker, scopeMarkerText, { mode: 0o600 });
  const pendingRecovery = await inspectCodexSetupRecovery(pending);
  assert.equal(pendingRecovery.recoverable, true);
  assert.equal(pendingRecovery.needsMarker, false);
  await writeFile(scopeMarker, scopeMarkerText.replace(`inode=${pendingInfo.ino}`, 'inode=1'), { mode: 0o600 });
  assert.equal((await inspectCodexSetupRecovery(pending)).recoverable, false, 'scope recovery must reject a marker copied from another destination');
  await writeFile(scopeMarker, scopeMarkerText, { mode: 0o600 });
  const stale = path.join(pending, '.source-roots.00000000-0000-4000-8000-000000000000.tmp');
  await writeFile(stale, 'incomplete', { mode: 0o600 });
  assert.deepEqual((await inspectCodexSetupRecovery(pending)).staleTemps, [stale]);
  await writeFile(path.join(pending, 'unrecognized.txt'), 'preserve me');
  assert.equal((await inspectCodexSetupRecovery(pending)).recoverable, false);
  await rm(path.join(pending, 'unrecognized.txt'));
  await rename(pending, `${pending}-moved`);
  assert.equal((await inspectCodexSetupRecovery(`${pending}-moved`)).recoverable, false);
  await rename(`${pending}-moved`, pending);

  const file = await writeCodexLocator({ home, destination, generation: 3 });
  const locator = readCodexLocator({ home });
  assert.equal(locator.status, 'connected');
  assert.equal(locator.destination, destination);
  assert.equal(locator.generation, 3);
  assert.equal((await lstat(file)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.dirname(file))).mode & 0o777, 0o700);

  const replacement = path.join(home, 'Desktop', 'DataBrain-replacement');
  await mkdir(replacement, { mode: 0o700 });
  await rename(destination, path.join(home, 'Desktop', 'DataBrain-old'));
  await rename(replacement, destination);
  assert.equal(readCodexLocator({ home }).status, 'destination-identity-changed');

  await rm(file);
  await symlink(path.join(temp, 'missing-target'), file);
  assert.throws(() => readCodexLocator({ home }), /protected regular file/);

  await rm(file);
  await writeCodexLocator({ home, destination: path.join(home, 'Desktop', 'DataBrain-old'), generation: 4 });
  const validBody = await readFile(file, 'utf8');
  await writeFile(file, validBody.replace('generation\t4', 'generation\tnope'));
  assert.throws(() => readCodexLocator({ home }), /invalid values/);

  console.log('PASS: Codex locator permissions/identity and interrupted-setup recovery markers are protected; unknown or moved destinations are rejected.');
} finally {
  await rm(temp, { recursive: true, force: true });
}
