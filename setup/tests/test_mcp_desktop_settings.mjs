import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-desktop-settings-')));

function startServer(parent, roots) {
  const server = spawn(process.execPath, [
    serverScript,
    '--databrain-parent', parent,
    '--databrain-source-roots', ...roots,
  ], { env: { ...process.env, HOME: path.join(temp, 'home'), DATABRAIN_TEST_STEP_BY_STEP: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }); // checks the state before indexing; the default flow indexes at once (test_mcp_setup_finish.mjs)
  const replies = new Map();
  const errors = [];
  const lines = readline.createInterface({ input: server.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', part => errors.push(part));
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  return { server, request, errors };
}

async function waitForStage(request, phrase) {
  let status = '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const reply = await request('tools/call', { name: 'databrain_setup_status', arguments: {} });
    status = reply.result.content[0].text;
    if (!status.includes('destination selection: running')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(status.includes(phrase), status);
  return status;
}

async function waitForJob(request, phrase) {
  let status = '';
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const reply = await request('tools/call', { name: 'databrain_setup_status', arguments: {} });
    status = reply.result.content[0].text;
    if (status.includes(phrase)) return status;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail(`Timed out waiting for ${phrase}: ${status}`);
}

async function initialize(client) {
  await client.request('initialize', { protocolVersion: '2025-03-26' });
  client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
}

try {
  const parent = path.join(temp, 'Chosen parent with spaces');
  const sourceA = path.join(temp, 'Source A');
  const sourceB = path.join(temp, 'Source B');
  const sourceC = path.join(temp, 'Source C');
  await Promise.all([parent, sourceA, sourceB, sourceC].map(folder => fs.mkdir(folder, { recursive: true })));
  const canonicalParent = await fs.realpath(parent);
  const canonicalA = await fs.realpath(sourceA);
  const canonicalB = await fs.realpath(sourceB);
  const canonicalC = await fs.realpath(sourceC);
  const fileA = path.join(canonicalA, 'private-a.md');
  const fileB = path.join(canonicalB, 'private-b.md');
  await fs.writeFile(fileA, '# Root A\nremovedsettingsmarker\n');
  await fs.writeFile(fileB, '# Root B\nretainedsettingsmarker\n');
  const beforeA = await fs.readFile(fileA);
  const beforeB = await fs.readFile(fileB);
  const dataHome = path.join(canonicalParent, 'DataBrain');
  const first = startServer(canonicalParent, [canonicalA, canonicalB]);

  try {
    await initialize(first);
    const preStart = await first.request('tools/call', { name: 'databrain_setup_status', arguments: {} });
    assert(preStart.result.content[0].text.includes('Stage: not configured'));
    await assert.rejects(fs.lstat(dataHome), { code: 'ENOENT' }, 'settings alone must not create DataBrain');
    assert.deepEqual(await fs.readFile(fileA), beforeA);
    assert.deepEqual(await fs.readFile(fileB), beforeB);

    const start = await first.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    assert(start.result.content[0].text.includes('Creating DataBrain under the parent selected in Claude Desktop settings'));
    await waitForStage(first.request, 'Stage: sources selected');
    const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    assert.equal(state.destinationParent, canonicalParent, 'the actual CLI parent path must be saved');
    assert.deepEqual(state.roots, [canonicalA, canonicalB], 'the expanded multiple directory argv values must become the saved grant');
    assert.deepEqual(state.rootIdentities.map(({ path: root, dev, ino }) => ({ path: root, dev, ino })), [canonicalA, canonicalB].map(root => {
      const info = lstatSync(root);
      return { path: root, dev: info.dev, ino: info.ino };
    }), 'the selected folder identities must be bound to the saved grants');
    assert.equal(await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8'), `${canonicalA}\n${canonicalB}\n`);
    await assert.rejects(fs.lstat(path.join(dataHome, 'moc')), { code: 'ENOENT' }, 'setup start must record grants without indexing/reading source files');
    assert.deepEqual(await fs.readFile(fileA), beforeA);
    assert.deepEqual(await fs.readFile(fileB), beforeB);

    const stateBytesBeforeRepeat = await fs.readFile(statePath);
    const repeatedStart = await first.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    assert(repeatedStart.result.content[0].text.includes('setup has already started'), repeatedStart.result.content[0].text);
    assert.deepEqual(await fs.readFile(statePath), stateBytesBeforeRepeat, 'repeating setup must not rewrite the saved destination or grants');
    assert.equal(await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8'), `${canonicalA}\n${canonicalB}\n`, 'repeating setup must not duplicate or replace source grants');
    await assert.rejects(fs.lstat(path.join(dataHome, 'moc')), { code: 'ENOENT' }, 'repeating setup must not start indexing as a side effect');
    assert.deepEqual(await fs.readFile(fileA), beforeA, 'repeating setup must leave source A unchanged');
    assert.deepEqual(await fs.readFile(fileB), beforeB, 'repeating setup must leave source B unchanged');

    // Seed generated artifacts for the settings-addition, read-only-audit, and revocation checks.
    const moc = path.join(dataHome, 'moc');
    await fs.mkdir(moc, { recursive: true });
    await fs.writeFile(path.join(moc, 'index.tsv'), `${fileA}\tPrivate A\ttest\tremovedsettingsmarker\n${fileB}\tPrivate B\ttest\tretainedsettingsmarker\n`);
    const grantPath = path.join(dataHome, '.source-roots');
    const built = spawnSync('/bin/bash', [path.join(engine, 'bin/build-fts.sh')], {
      env: { ...process.env, HOME: path.join(temp, 'home'), NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: grantPath },
      encoding: 'utf8',
    });
    assert.equal(built.status, 0, `could not seed the disposable search database: ${built.stderr}`);
  } finally {
    first.server.kill('SIGTERM');
    if (first.server.exitCode === null) await new Promise(resolve => first.server.once('exit', resolve));
  }

  const added = startServer(canonicalParent, [canonicalA, canonicalB, canonicalC]);
  try {
    await initialize(added);
    const result = await added.request('tools/call', { name: 'databrain_add_sources', arguments: {} });
    assert(result.result.content[0].text.includes('Reconciliation job:'), result.result.content[0].text);
    await waitForJob(added.request, 'source grant reconciliation: complete');
    const addedState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
    assert.deepEqual(addedState.roots, [canonicalA, canonicalB, canonicalC], 'adding settings-selected roots must preserve earlier approved roots');
  } finally {
    added.server.kill('SIGTERM');
    if (added.server.exitCode === null) await new Promise(resolve => added.server.once('exit', resolve));
  }

  const restarted = startServer(canonicalParent, [canonicalB]);
  try {
    await initialize(restarted);
    const beforeAuditState = await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8');
    const beforeAuditGrant = await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8');
    const beforeAuditIndex = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
    const audit = await restarted.request('tools/call', { name: 'databrain_verify_install', arguments: {} });
    const auditText = audit.result.content[0].text;
    assert(auditText.includes('FAIL: Claude Desktop settings match'), auditText);
    assert(auditText.includes('do not exactly match the saved destination and grants'), auditText);
    assert.equal(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'), beforeAuditState, 'install audit must not rewrite setup state');
    assert.equal(await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8'), beforeAuditGrant, 'install audit must not rewrite folder grants');
    assert.equal(await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8'), beforeAuditIndex, 'install audit must not prune generated records');

    const removedSearch = await restarted.request('tools/call', { name: 'databrain_search', arguments: { query: 'removedsettingsmarker' } });
    assert(/(?:No approved-source matches|no matches)/i.test(removedSearch.result.content[0].text), removedSearch.result.content[0].text);
    const revokedState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
    assert.deepEqual(revokedState.roots, [canonicalB], 'a root removed from settings must be revoked on the first request after restart');
    assert.equal(await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8'), `${canonicalB}\n`);
    assert(!await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8').then(text => text.includes(fileA)));
    const directRead = await restarted.request('tools/call', { name: 'databrain_read', arguments: { path: fileA } });
    assert(!directRead.result.content[0].text.includes('removedsettingsmarker'), 'a revoked file must never be returned by read');
  } finally {
    restarted.server.kill('SIGTERM');
    if (restarted.server.exitCode === null) await new Promise(resolve => restarted.server.once('exit', resolve));
  }

  const settingsMismatch = startServer(canonicalParent, [canonicalB, canonicalC]);
  try {
    await initialize(settingsMismatch);
    const deniedSearch = await settingsMismatch.request('tools/call', { name: 'databrain_search', arguments: { query: 'retainedsettingsmarker' } });
    assert(deniedSearch.result.content[0].text.includes('settings changed'), deniedSearch.result.content[0].text);
    const audit = await settingsMismatch.request('tools/call', { name: 'databrain_verify_install', arguments: {} });
    const auditText = audit.result.content[0].text;
    assert(auditText.includes('FAIL: Claude Desktop settings match'), auditText);
    assert(auditText.includes('do not exactly match the saved destination and grants'), auditText);
  } finally {
    settingsMismatch.server.kill('SIGTERM');
    if (settingsMismatch.server.exitCode === null) await new Promise(resolve => settingsMismatch.server.once('exit', resolve));
  }

  const identityParent = path.join(temp, 'Identity parent');
  const identitySource = path.join(temp, 'Identity source');
  await fs.mkdir(identityParent, { recursive: true });
  await fs.mkdir(identitySource, { recursive: true });
  const identityPath = await fs.realpath(identitySource);
  await fs.writeFile(path.join(identityPath, 'original.md'), '# Original\noriginalidentitymarker\n');
  const identityServer = startServer(await fs.realpath(identityParent), [identityPath]);
  try {
    await initialize(identityServer);
    const start = await identityServer.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    assert(start.result.content[0].text.includes('Creating DataBrain'), start.result.content[0].text);
    await waitForStage(identityServer.request, 'Stage: sources selected');
  } finally {
    identityServer.server.kill('SIGTERM');
    if (identityServer.server.exitCode === null) await new Promise(resolve => identityServer.server.once('exit', resolve));
  }
  await fs.rename(identityPath, `${identityPath}.original`);
  await fs.mkdir(identityPath);
  await fs.writeFile(path.join(identityPath, 'replacement.md'), '# Replacement\nreplacementidentitysecret\n');
  const replaced = startServer(await fs.realpath(identityParent), [identityPath]);
  try {
    await initialize(replaced);
    const beforeIdentityAudit = await fs.readFile(path.join(identityParent, 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8');
    const identityAudit = await replaced.request('tools/call', { name: 'databrain_verify_install', arguments: {} });
    assert(identityAudit.result.content[0].text.includes('BLOCKED: Local setup audit — An approved source folder changed identity'), identityAudit.result.content[0].text);
    assert.equal(await fs.readFile(path.join(identityParent, 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8'), beforeIdentityAudit, 'an identity mismatch audit must remain read-only');
    const denied = await replaced.request('tools/call', { name: 'databrain_search', arguments: { query: 'replacementidentitysecret' } });
    assert(denied.result.content[0].text.includes('changed identity'), denied.result.content[0].text);
    assert(!denied.result.content[0].text.includes('replacementidentitysecret'), 'a replacement directory must not be searchable under the old approval');
    const oldState = JSON.parse(await fs.readFile(path.join(identityParent, 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8'));
    const oldIdentity = oldState.rootIdentities.find(entry => entry.path === identityPath);
    assert.equal(oldIdentity.ino, (await fs.lstat(`${identityPath}.original`)).ino, 'the saved identity must remain bound to the originally selected directory');
    const guardedMoc = path.join(temp, 'identity-guard-moc');
    const guardedBuild = spawnSync('/bin/bash', [path.join(engine, 'bin/build-index.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        NB_MOC_DIR: guardedMoc,
        NB_CANON_ROOTS_FILE: path.join(identityParent, 'DataBrain', '.source-roots'),
        NB_CANON_ROOT_IDENTITIES_FILE: path.join(identityParent, 'DataBrain', '.databrain', 'root-identities.tsv'),
      },
    });
    assert.notEqual(guardedBuild.status, 0, 'the engine must reject a replaced root even if a directory swap happens after MCP startup');
    assert(guardedBuild.stderr.includes('changed identity'), guardedBuild.stderr);
    await assert.rejects(fs.lstat(path.join(guardedMoc, 'index.tsv')), { code: 'ENOENT' }, 'a rejected replacement root must not create an index');
    const reselect = await replaced.request('tools/call', { name: 'databrain_select_sources', arguments: {} });
    assert(reselect.result.content[0].text.includes('Reconciliation job:'), reselect.result.content[0].text);
    await waitForJob(replaced.request, 'source grant reconciliation: complete');
    const newState = JSON.parse(await fs.readFile(path.join(identityParent, 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8'));
    assert.notEqual(newState.rootIdentities.find(entry => entry.path === identityPath).ino, oldIdentity.ino, 'explicit source re-selection must bind the newly selected folder identity');
  } finally {
    replaced.server.kill('SIGTERM');
    if (replaced.server.exitCode === null) await new Promise(resolve => replaced.server.once('exit', resolve));
  }

  const existingParent = path.join(temp, 'Existing parent');
  const existingHome = path.join(existingParent, 'DataBrain');
  await fs.mkdir(existingHome, { recursive: true });
  await fs.writeFile(path.join(existingHome, 'keep.txt'), 'leave this alone');
  const existing = startServer(await fs.realpath(existingParent), [canonicalA]);
  try {
    await initialize(existing);
    const refusal = await existing.request('tools/call', { name: 'databrain_setup_start', arguments: {} });
    assert(refusal.result.content[0].text.includes('already exists'), refusal.result.content[0].text);
    assert.equal(await fs.readFile(path.join(existingHome, 'keep.txt'), 'utf8'), 'leave this alone');
    await assert.rejects(fs.lstat(path.join(existingHome, '.databrain')), { code: 'ENOENT' });
  } finally {
    existing.server.kill('SIGTERM');
    if (existing.server.exitCode === null) await new Promise(resolve => existing.server.once('exit', resolve));
  }

  const manifest = JSON.parse(await fs.readFile(path.join(here, '../mcp/manifest.json'), 'utf8'));
  const args = manifest.server.mcp_config.args;
  assert.deepEqual(args.slice(1), ['--databrain-parent', '${user_config.data_parent}', '--databrain-source-roots', '${user_config.source_roots}']);
  assert.equal(manifest.user_config.data_parent.type, 'directory');
  // optional, and defaults to the home folder so nobody has to choose a location (the server also falls back to home)
  assert.equal(manifest.user_config.data_parent.default, undefined);
  assert.equal(manifest.user_config.data_parent.required, false);
  assert.equal(manifest.user_config.source_roots.type, 'directory');
  assert.equal(manifest.user_config.source_roots.multiple, true);
  console.log('PASS: MCPB Desktop settings map to argv; setup consent gates creation/reads; repeated setup preserves state, grants, and sources; multiple roots persist; add preserves grants; audit reports drift without mutation; changed folder identity requires re-selection; removed settings roots are revoked before search/read.');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
