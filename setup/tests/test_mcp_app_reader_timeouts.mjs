// App-reader interpreter deadlines must be bounded even when a fake helper ignores TERM and eventually exits successfully.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverDir = process.env.DATABRAIN_SERVER
  ? path.dirname(path.resolve(process.env.DATABRAIN_SERVER))
  : path.resolve(here, '../mcp');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-app-timeout-')));
const home = path.join(temp, 'home');
const pidFile = path.join(temp, 'helper.pid');
const termFile = path.join(temp, 'helper.term');
const descendantFile = path.join(temp, 'helper.descendant');
const helper = path.join(temp, 'interpreter-stub.mjs');
const fastHelper = path.join(temp, 'interpreter-fast-stub.mjs');
const stubbornHelper = path.join(temp, 'interpreter-stubborn-stub.mjs');
const lifecycleHelper = path.join(temp, 'lifecycle-stub.sh');
const lifecycleLog = path.join(temp, 'lifecycle.log');
const lifecyclePid = path.join(temp, 'lifecycle.pid');
const lifecycleDescendant = path.join(temp, 'lifecycle.descendant');
const stubbornGrandchild = path.join(temp, 'helper.grandchild');
const interpreterMarker = path.join(temp, 'interpreter.called');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
await fs.mkdir(home, { recursive: true });
await fs.writeFile(fastHelper, '#!/bin/bash\nprintf called > "$HELPER_FAST_FILE"\nprintf \'[]\\n\'\n', { mode: 0o755 });
await fs.writeFile(helper, `#!/bin/bash
printf '%s' "$$" > "$HELPER_PID_FILE"
trap 'printf ignored > "$HELPER_TERM_FILE"' TERM
sleep 3 & printf '%s' "$!" > "$HELPER_DESCENDANT_FILE"; wait $!
printf '[]\\n'
exit 0
`, { mode: 0o755 });
await fs.writeFile(stubbornHelper, `#!/bin/bash
printf '%s' "$$" > "$HELPER_PID_FILE"
bash -c 'trap "" TERM; sleep 3 & printf "%s" "$!" > "$HELPER_GRANDCHILD"; wait $!' >/dev/null 2>&1 & printf '%s' "$!" > "$HELPER_DESCENDANT_FILE"
trap 'printf ignored > "$HELPER_TERM_FILE"; exit 0' TERM
wait $!
printf '[]\\n'
exit 0
`, { mode: 0o755 });
await fs.writeFile(lifecycleHelper, `#!/bin/bash
case "$1" in
  running)
    if [ "$LIFECYCLE_MODE" = timeout ]; then
      printf 'running\\n' >> "$LIFECYCLE_LOG"
      printf '%s' "$$" > "$LIFECYCLE_PID"
      bash -c 'trap "" TERM; sleep 24' >/dev/null 2>&1 & printf '%s' "$!" > "$LIFECYCLE_DESCENDANT"
      trap 'exit 0' TERM
      wait $!
      exit 0
    fi
    if [ "$LIFECYCLE_MODE" = error-first ]; then
      count=$(cat "$LIFECYCLE_LOG" 2>/dev/null | wc -l | tr -d ' ')
      printf 'running\\n' >> "$LIFECYCLE_LOG"
      if [ "$count" = 0 ]; then exit 1; fi
      printf true
      exit 0
    fi
    if [ "$LIFECYCLE_MODE" = invalid ]; then printf 'running\\n' >> "$LIFECYCLE_LOG"; printf ambiguous; exit 0; fi
    count=$(grep -c '^running$' "$LIFECYCLE_LOG" 2>/dev/null || true)
    printf 'running\\n' >> "$LIFECYCLE_LOG"
    if [ "$count" = 0 ]; then printf false; exit 0; fi
    if [ "$LIFECYCLE_MODE" = poll-fail ] && [ "$count" = 1 ]; then exit 1; fi
    if [ "$LIFECYCLE_MODE" = poll-invalid ] && [ "$count" = 1 ]; then printf ambiguous; exit 0; fi
    printf true
    exit 0
    ;;
  launch|hide)
    printf '%s\\n' "$1" >> "$LIFECYCLE_LOG"
    if [ "$LIFECYCLE_MODE" = launch-fail ] && [ "$1" = launch ]; then exit 1; fi
    if [ "$LIFECYCLE_MODE" = hide-fail ] && [ "$1" = hide ]; then exit 1; fi
    exit 0
    ;;
esac
`, { mode: 0o755 });

try {
  process.env.HOME = home;
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = helper;
  process.env.DATABRAIN_TEST_APP_TIMEOUT_MS = '1000';
  process.env.HELPER_PID_FILE = pidFile;
  process.env.HELPER_TERM_FILE = termFile;
  process.env.HELPER_DESCENDANT_FILE = descendantFile;
  process.env.HELPER_GRANDCHILD = stubbornGrandchild;
  process.env.HELPER_FAST_FILE = interpreterMarker;
  const hooks = await import(path.join(serverDir, 'test-hooks.mjs'));
  assert.equal(hooks.testHook('DATABRAIN_TEST_APP_OSASCRIPT'), helper, 'fake-home lifecycle hooks are active');
  const helperProbe = spawnSync('/bin/bash', ['-c', 'exec "$@"', 'bash', helper, '-l', 'JavaScript', '-e', 'test'], { encoding: 'utf8' });
  assert.equal(helperProbe.status, 0, `the synthetic helper launches directly (${helperProbe.stderr})`);
  const readers = await import(path.join(serverDir, 'app-readers.mjs'));
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = fastHelper;
  const healthy = await readers.withBackgroundApp({ name: 'Fixture', bundlePath: '/synthetic/Fixture.app', sdefPath: '/synthetic/Fixture.sdef' }, session => session.run('// synthetic fast result'));
  assert.equal(healthy.ok, true, `a healthy interpreter result before the deadline remains successful (${JSON.stringify(healthy)})`);
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = helper;
  const startedAt = Date.now();
  const result = await readers.withBackgroundApp({ name: 'Fixture', bundlePath: '/synthetic/Fixture.app', sdefPath: '/synthetic/Fixture.sdef' }, session => session.run('// synthetic interpreter timeout'));
  const elapsed = Date.now() - startedAt;
  const helperPid = await fs.readFile(pidFile, 'utf8').catch(() => 'not started');
  const descendantPid = await fs.readFile(descendantFile, 'utf8').catch(() => 'not started');
  const termObserved = await fs.readFile(termFile, 'utf8').catch(() => 'not observed');
  assert.match(helperPid, /^\d+$/, `the guarded fake interpreter started (elapsed ${elapsed} ms, pid=${JSON.stringify(helperPid)}, result ${JSON.stringify(result)})`);
  assert.match(descendantPid, /^\d+$/, `the fake interpreter started its owned pipe-holding descendant (pid=${JSON.stringify(descendantPid)})`);
  assert.notEqual(termObserved, 'not observed', 'the production interpreter timeout sent SIGTERM to the fake helper');
  assert.equal(result.ok, false, 'a helper that exits zero after the deadline is still a timeout failure');
  assert(elapsed < 2500, `the app-reader caller returns before the helper's 3 s self-exit (elapsed ${elapsed} ms)`);
  for (const pid of [helperPid, descendantPid]) {
    await assertGone(pid);
  }
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = stubbornHelper;
  const stubbornStartedAt = Date.now();
  const stubbornResult = await readers.withBackgroundApp({ name: 'Fixture', bundlePath: '/synthetic/Fixture.app', sdefPath: '/synthetic/Fixture.sdef' }, session => session.run('// synthetic stubborn interpreter timeout'));
  const stubbornElapsed = Date.now() - stubbornStartedAt;
  const stubbornPids = [await fs.readFile(pidFile, 'utf8'), await fs.readFile(descendantFile, 'utf8'), await fs.readFile(stubbornGrandchild, 'utf8')];
  assert.equal(stubbornResult.ok, false, 'a TERM-ignoring helper is a timeout failure');
  assert(stubbornElapsed < 2500, `TERM-ignoring helper group is stopped within a bounded interval (${stubbornElapsed} ms)`);
  for (const pid of stubbornPids) await assertGone(pid);
  process.env.DATABRAIN_TEST_APP_LIFECYCLE = lifecycleHelper;
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = fastHelper;
  process.env.LIFECYCLE_LOG = lifecycleLog;
  process.env.LIFECYCLE_PID = lifecyclePid;
  process.env.LIFECYCLE_DESCENDANT = lifecycleDescendant;
  process.env.LIFECYCLE_MODE = 'error-first';
  const beforeCheckFailure = await readers.withBackgroundApp({ name: 'Fixture', bundleId: 'synthetic.fixture', bundlePath: '/synthetic/Fixture.app' }, async session => [await session.run('// synthetic failed running check'), await session.run('// synthetic second script')]);
  const failureCalls = (await fs.readFile(lifecycleLog, 'utf8')).trim().split('\n');
  assert.deepEqual(beforeCheckFailure.map(result => result.ok), [false, false], 'a failed app-running check remains latched and aborts later scripts');
  assert.deepEqual(failureCalls, ['running'], `failed running check never launches or hides the app (${failureCalls.join(',')})`);
  await fs.writeFile(lifecycleLog, '');
  process.env.LIFECYCLE_MODE = 'invalid';
  const invalidCheck = await readers.withBackgroundApp({ name: 'Fixture', bundleId: 'synthetic.fixture', bundlePath: '/synthetic/Fixture.app' }, session => session.run('// synthetic invalid running check'));
  const invalidCalls = (await fs.readFile(lifecycleLog, 'utf8')).trim().split('\n');
  assert.equal(invalidCheck.ok, false, 'successful but malformed app-running output is unknown and aborts');
  assert.deepEqual(invalidCalls, ['running'], `invalid running output never launches or hides the app (${invalidCalls.join(',')})`);
  for (const [mode, expectedCalls] of [
    ['launch-fail', ['running', 'launch']],
    ['poll-fail', ['running', 'launch', 'running']],
    ['poll-invalid', ['running', 'launch', 'running']],
    ['hide-fail', ['running', 'launch', 'running', 'hide']],
  ]) {
    await fs.writeFile(lifecycleLog, '');
    await fs.rm(interpreterMarker, { force: true });
    process.env.LIFECYCLE_MODE = mode;
    const failedLifecycle = await readers.withBackgroundApp({ name: 'Fixture', bundleId: 'synthetic.fixture', bundlePath: '/synthetic/Fixture.app' }, async session => [await session.run(`// synthetic ${mode}`), await session.run('// synthetic second script')]);
    const lifecycleCalls = (await fs.readFile(lifecycleLog, 'utf8')).trim().split('\n');
    assert.deepEqual(failedLifecycle.map(result => result.ok), [false, false], `${mode} failure remains latched`);
    assert.deepEqual(lifecycleCalls, expectedCalls, `${mode} fails closed at the expected lifecycle step (${lifecycleCalls.join(',')})`);
    assert.equal(await fs.access(interpreterMarker).then(() => true, () => false), false, `${mode} failure never invokes the app interpreter`);
  }
  await fs.writeFile(lifecycleLog, '');
  await fs.rm(interpreterMarker, { force: true });
  process.env.LIFECYCLE_MODE = 'success';
  const validLaunch = await readers.withBackgroundApp({ name: 'Fixture', bundleId: 'synthetic.fixture', bundlePath: '/synthetic/Fixture.app' }, session => session.run('// synthetic successful launch'));
  assert.equal(validLaunch.ok, true, 'a valid false, successful launch, true poll and successful hide still reads');
  assert.deepEqual((await fs.readFile(lifecycleLog, 'utf8')).trim().split('\n'), ['running', 'launch', 'running', 'hide']);
  assert.equal(await fs.access(interpreterMarker).then(() => true, () => false), true, 'the successful lifecycle reaches the interpreter');
  await fs.writeFile(lifecycleLog, '');
  process.env.LIFECYCLE_MODE = 'timeout';
  const runToolStartedAt = Date.now();
  const timedOutCheck = await readers.withBackgroundApp({ name: 'Fixture', bundleId: 'synthetic.fixture', bundlePath: '/synthetic/Fixture.app' }, session => session.run('// synthetic timed-out running check'));
  const runToolElapsed = Date.now() - runToolStartedAt;
  const timeoutCalls = (await fs.readFile(lifecycleLog, 'utf8')).trim().split('\n');
  assert.equal(timedOutCheck.ok, false, 'a timed-out lifecycle running check fails closed');
  assert(runToolElapsed < 23000, `the 20 s lifecycle timeout returns before the 24 s helper self-exit (${runToolElapsed} ms)`);
  assert.deepEqual(timeoutCalls, ['running'], `timed-out running check never launches or hides the app (${timeoutCalls.join(',')})`);
  for (const pid of [await fs.readFile(lifecyclePid, 'utf8'), await fs.readFile(lifecycleDescendant, 'utf8')]) await assertGone(pid);
  console.log(`PASS: app interpreter timeout fails and terminates its owned helper group (late-zero ${elapsed} ms; stubborn ${stubbornElapsed} ms).`);
} finally {
  // The invented helper exits by itself after three seconds if the process-group signal is unavailable in a test sandbox.
  await wait(3100);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}

async function assertGone(pid) {
  assert.match(pid, /^\d+$/, `captured owned process pid (${JSON.stringify(pid)})`);
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { process.kill(Number(pid), 0); } catch (error) { if (error.code === 'ESRCH') return; }
    await wait(25);
  }
  assert.fail(`owned process ${pid} remained after timeout cleanup`);
}
