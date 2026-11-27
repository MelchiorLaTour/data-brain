// The shared test harness removes every fake home it made when the test process ends, whether the test passed, failed an assertion or threw.
// Runs three tiny child processes against a private temp folder and checks that the folder is empty afterwards.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-cleanup-check-')));
const harness = path.join(here, 'mcp-harness-0138.mjs');
const run = body => spawnSync(process.execPath, ['--input-type=module', '-e', `import { fakeHome } from ${JSON.stringify(harness)}; ${body}`], { env: { ...process.env, TMPDIR: tmp }, encoding: 'utf8' });
try {
  const cases = [
    ['a passing test', 'const a = await fakeHome("one"); const b = await fakeHome("two"); await import("node:fs/promises").then(f => f.writeFile(a.home + "/x", "x"));', 0],
    ['a failed assertion', 'const a = await fakeHome("three"); (await import("node:assert/strict")).default.equal(1, 2);', 1],
    ['an uncaught error', 'await fakeHome("four"); throw new Error("boom");', 1],
    ['a TERM signal', 'await fakeHome("five"); process.kill(process.pid, "SIGTERM"); await new Promise(r => setTimeout(r, 2000));', 1],
  ];
  for (const [label, body, status] of cases) {
    const result = run(body);
    assert.equal(result.status, status, `${label}: exit status\n${result.stderr}`);
    const left = (await fs.readdir(tmp)).filter(name => name.startsWith('databrain-'));
    assert.deepEqual(left, [], `${label}: fake homes left behind in the temp folder`);
  }
  console.log('PASS: the test harness removes every fake home it made at the end of the process (pass, failed assertion, uncaught error, TERM): nothing is left behind.');
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}
