// Every DATABRAIN_TEST_* and NB_TEST_* hook is ignored when HOME is the real home folder. Some hooks run a given program or skip a consent
// step, so a real session must never honour them. The list of hooks is read from the source, so a hook added later is covered automatically.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const mcp = process.env.DATABRAIN_SERVER ? path.dirname(path.resolve(process.env.DATABRAIN_SERVER)) : path.join(here, '../mcp');
const bin = path.resolve(mcp, '../../bin');
const realHome = os.userInfo().homedir;
const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'databrain-hooks-')));
try {
  const names = new Set();
  for (const dir of [mcp, bin]) for (const file of fs.readdirSync(dir)) {
    if (!/\.(mjs|js|sh)$/.test(file) || file === 'test-hooks.mjs') continue;
    for (const match of fs.readFileSync(path.join(dir, file), 'utf8').matchAll(/(?:DATABRAIN|NB)_TEST_[A-Z0-9_]+/g)) names.add(match[0]);
  }
  assert(names.size >= 25, `the hook list was read from the source (${names.size} found)`);
  assert(names.has('DATABRAIN_TEST_CONSENT'), 'the chat-consent hook is included');
  assert(names.has('NB_TEST_DATALESS_LIST'), 'the cloud dataless-list hook is included');
  const allSet = Object.fromEntries([...names].map(name => [name, '1']));
  const probe = home => JSON.parse(spawnSync(process.execPath, ['--input-type=module', '-e',
    `import { testHook } from ${JSON.stringify(path.join(mcp, 'test-hooks.mjs'))}; console.log(JSON.stringify({ left: Object.keys(process.env).filter(k => /^(?:DATABRAIN|NB)_TEST_/.test(k)), viaHook: ${JSON.stringify([...names])}.filter(n => testHook(n) !== undefined) }))`],
    { env: { PATH: process.env.PATH, HOME: home, ...allSet }, encoding: 'utf8' }).stdout);
  const real = probe(realHome);
  assert.deepEqual(real, { left: [], viaHook: [] }, `with HOME = the real home, every hook is ignored: ${JSON.stringify(real)}`);
  const fake = probe(temp);
  assert.equal(fake.left.length, names.size, 'with another HOME the hooks work (tests need them)');
  assert.equal(fake.viaHook.length, names.size);

  // The two named in the security review, end to end: a program given by the hook must NOT run when HOME is the real home.
  const sentinel = path.join(temp, 'ran.log');
  const stub = path.join(temp, 'stub.sh'); fs.writeFileSync(stub, `#!/bin/sh\necho "$0 $*" >> "${sentinel}"\necho '[]'\n`, { mode: 0o755 });
  const bundle = path.join(temp, 'Stub.app'); fs.mkdirSync(path.join(bundle, 'Contents', 'Resources'), { recursive: true });
  const sdef = path.join(bundle, 'Contents', 'Resources', 'S.sdef');
  fs.writeFileSync(sdef, '<dictionary><suite name="S"><class name="page" code="page" plural="pages"><property name="title" code="titl" type="text"/><property name="text" code="ctxt" type="text"/></class></suite></dictionary>');
  const app = { name: 'Stub', bundleId: 'test.hooks.stub', bundlePath: bundle, sdefPath: sdef };
  const runWith = home => {
    fs.rmSync(sentinel, { force: true });
    const code = `import * as readers from ${JSON.stringify(path.join(mcp, 'test-hooks.mjs'))}; const r = await import(${JSON.stringify(path.join(mcp, 'app-readers.mjs'))});
      await r.exportApps({ roots: [], mirrorRoot: ${JSON.stringify(path.join(temp, 'mirror'))}, apps: [${JSON.stringify(app)}] }).catch(() => {});
      await r.withBackgroundApp(${JSON.stringify(app)}, async () => 1).catch(() => {}); console.log(JSON.stringify(r.applicationDirs()));`;
    const out = spawnSync(process.execPath, ['--input-type=module', '-e', code],
      { env: { PATH: process.env.PATH, HOME: home, DATABRAIN_TEST_APP_OSASCRIPT: stub, DATABRAIN_TEST_APP_LIFECYCLE: stub, DATABRAIN_TEST_APP_DIRS: path.join(temp, 'fakeapps'), DATABRAIN_TEST_APP_TIMEOUT_MS: '20000' }, encoding: 'utf8', timeout: 90000 });
    return { ran: fs.existsSync(sentinel) ? fs.readFileSync(sentinel, 'utf8') : '', dirs: out.stdout.trim() };
  };
  const guarded = runWith(realHome);
  assert.equal(guarded.ran, '', `the given interpreter and lifecycle tool did not run with the real home:\n${guarded.ran}`);
  assert(!guarded.dirs.includes('fakeapps') && guarded.dirs.includes('/Applications'), `the app folder hook was ignored: ${guarded.dirs}`);
  const control = runWith(temp);
  assert(control.ran.includes('stub.sh'), 'control: with another HOME the same hooks do run the stub');
  assert(control.dirs.includes('fakeapps'), 'control: the app folder hook works with another HOME');
  console.log(`PASS: all ${names.size} DATABRAIN_TEST_* and NB_TEST_* hooks are ignored when HOME is the real home (app interpreter, app lifecycle tool and app folders proven end to end); they work with any other HOME.`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
