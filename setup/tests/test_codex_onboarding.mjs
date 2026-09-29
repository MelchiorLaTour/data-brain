import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { CODEX_SETUP_MARKER, readCodexLocator, writeCodexSetupMarker, writeCodexLocator } from '../mcp/codex-state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const testLauncher = process.env.DATABRAIN_TEST_LAUNCHER;
const CODEX_SCOPE_COMMIT_MARKER_FOR_TEST = 'codex-scope-commit-pending.tsv';
const CODEX_SETUP_MARKER_FOR_TEST = CODEX_SETUP_MARKER;
const detachedWorkerNoteCount = process.env.DATABRAIN_TEST_CLOSE_HOST_NOTE_COUNT === '500' ? 500 : 120;
const temp = await mkdtemp(path.join(os.tmpdir(), 'databrain-codex-onboarding-'));

function waitForChildExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise(resolve => child.once('exit', resolve));
}

async function launchCase(name, approved, preseedIncomplete = false, resumeInterruptedWorker = false, closeHostDuringIndexing = false, taxonomyCrashAfter = null, relationshipCrashAfter = null, indexCrashAfter = null) {
  const home = path.join(await realpath(temp), name);
  const desktop = path.join(home, 'Desktop');
  const source = path.join(home, 'Documents', 'Project notes');
  const destination = path.join(desktop, 'DataBrain');
  const selectionFile = path.join(home, 'selection.json');
  const indexCrashFile = path.join(home, 'index-crash-once');
  await mkdir(desktop, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'plan.md'), '# Project plan\nThe release decision is to preserve the approved source files.\n');
  if (indexCrashAfter) await writeFile(indexCrashFile, 'crash once after requested index transaction boundary');
  if (closeHostDuringIndexing && process.env.DATABRAIN_TEST_CLOSE_HOST_DURING_INDEXING === '1') {
    for (let index = 0; index < detachedWorkerNoteCount; index += 1) {
      await writeFile(path.join(source, `synthetic-${String(index).padStart(4, '0')}.md`), `# Synthetic note ${index}\nThe disposable fixture records local setup evidence ${index}.\n`);
    }
  }
  if (preseedIncomplete) {
    await mkdir(destination, { mode: 0o700 });
    writeCodexSetupMarker(destination);
    const sourceInfo = await lstat(source);
    await writeFile(path.join(destination, '.source-roots'), `${source}\n`, { mode: 0o600 });
    await mkdir(path.join(destination, '.databrain'), { mode: 0o700 });
    await writeFile(path.join(destination, '.databrain', 'root-identities.tsv'), `${source}\t${sourceInfo.dev}:${sourceInfo.ino}\n`, { mode: 0o600 });
  }
  if (resumeInterruptedWorker) {
    const sourceInfo = await lstat(source);
    await mkdir(destination, { recursive: true, mode: 0o700 });
    await mkdir(path.join(destination, '.databrain'), { mode: 0o700 });
    await writeFile(path.join(destination, '.source-roots'), `${source}\n`, { mode: 0o600 });
    await writeFile(path.join(destination, '.databrain', 'root-identities.tsv'), `${source}\t${sourceInfo.dev}:${sourceInfo.ino}\n`, { mode: 0o600 });
    const now = new Date().toISOString();
    await writeFile(path.join(destination, '.databrain', 'desktop-state.json'), `${JSON.stringify({
      client: 'codex',
      stage: 'indexing',
      destinationParent: desktop,
      roots: [source],
      rootIdentities: [{ path: source, dev: sourceInfo.dev, ino: sourceInfo.ino }],
      approvedScope: { version: 1, generation: 1, recursiveRead: true, localDerivedWrites: true, autoCategorize: true },
      createdAt: now,
      updatedAt: now,
      indexJob: { id: 'interrupted-worker', kind: 'initial indexing', status: 'running', ownerPid: 2147483647, startedAt: now, updatedAt: '2020-01-01T00:00:00.000Z' },
    }, null, 2)}\n`, { mode: 0o600 });
    await writeCodexLocator({ home, destination, generation: 1 });
  }
  await writeFile(selectionFile, JSON.stringify({
    selections: { sources: [source], 'destination-parent': [desktop] },
    approved,
  }));
  let server = spawn(testLauncher || process.execPath, testLauncher ? [] : [serverScript, '--databrain-client', 'codex'], {
    env: {
      ...process.env,
      HOME: home,
      DATABRAIN_TEST_HOME: destination,
      DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      ...(taxonomyCrashAfter ? { DATABRAIN_TEST_TAXONOMY_CRASH_AFTER: taxonomyCrashAfter } : {}),
      ...(relationshipCrashAfter ? { DATABRAIN_TEST_RELATIONSHIP_CRASH_AFTER: relationshipCrashAfter } : {}),
      ...(indexCrashAfter ? { DATABRAIN_TEST_INDEX_CRASH_AFTER: indexCrashAfter, DATABRAIN_TEST_INDEX_CRASH_ONCE_FILE: indexCrashFile } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let lines;
  const attachReplies = child => {
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
  };
  attachReplies(server);
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 10000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    assert(!response.error, JSON.stringify(response.error));
    return response.result.content?.[0]?.text || '';
  };
  const waitFor = async predicate => {
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const status = await call('databrain_setup_status');
      if (predicate(status)) return status;
      if (/Background job [0-9a-f-]+: failed\s+—/i.test(status)) throw new Error(`Indexing failed during setup: ${status}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for setup stage: ${await call('databrain_setup_status')}`);
  };

  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26' });
    assert.match(initialized.result.instructions, /continue without asking the user to stay present/i);
    const instructionLead = initialized.result.instructions.slice(0, 512).trimEnd();
    assert.match(instructionLead, /^Index user-selected local folders/);
    assert.match(instructionLead, /one approval covering setup/);
    assert.match(instructionLead, /read excerpts enter ChatGPT/);
    assert.match(instructionLead, /Scope changes need fresh approval\.$/);
    const listed = await request('tools/list');
    const descriptions = new Map(listed.result.tools.map(tool => [tool.name, tool.description]));
    assert.match(descriptions.get('databrain_setup_start'), /native source and destination choosers/);
    assert.match(descriptions.get('databrain_taxonomy_candidates'), /continue without asking for another permission/);
    assert.match(descriptions.get('databrain_apply_taxonomy'), /Do not pause for another approval/);
    assert.doesNotMatch(descriptions.get('databrain_taxonomy_candidates'), /ask the user to confirm/i);
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const initialStatus = await call('databrain_setup_status');
    assert.doesNotMatch(initialStatus, /explicitly confirms setup in chat|Claude Desktop extension settings/i);
    if (!resumeInterruptedWorker) {
      assert.match(initialStatus, /native dialogs/);
      const started = await call('databrain_setup_start');
      assert(started.includes('initial setup permission flow'));
    } else {
      assert.match(initialStatus, /Stage: indexing/);
      assert.match(initialStatus, /Background job interrupted-worker: starting/);
      assert.match(initialStatus, /you do not need to stay present/);
    }
    if (!approved) {
      const status = await waitFor(value => value.includes('initial setup permissions: cancelled'));
      await assert.rejects(lstat(destination), { code: 'ENOENT' });
      assert.equal(readCodexLocator({ home }).status, 'missing');
      return { status, destination, sourceFile: path.join(source, 'plan.md') };
    }

    if (closeHostDuringIndexing) {
      const runningStatus = await waitFor(value => /Background job [0-9a-f-]+: running/.test(value));
      const savedBeforeClose = JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8'));
      const workerJobId = savedBeforeClose.indexJob.id;
      assert.match(runningStatus, new RegExp(`Background job ${workerJobId}: running`));
      assert(Number.isSafeInteger(savedBeforeClose.indexJob.ownerPid), 'the persistent worker must publish its process ID before the host closes');
      server.kill('SIGTERM');
      await waitForChildExit(server);
      let completed = null;
      let latestAfterClose = null;
      for (let attempt = 0; attempt < 12000; attempt += 1) {
        const current = JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8'));
        latestAfterClose = current;
        if (current.stage === 'taxonomy pending' && current.indexJob?.id === workerJobId && current.indexJob.status === 'complete') {
          completed = current;
          break;
        }
        if (['failed', 'cancelled'].includes(current.indexJob?.status)) break;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      assert(completed, `the detached worker must finish indexing after the MCP host process exits; latest saved state: ${JSON.stringify(latestAfterClose?.indexJob)}`);
      const indexedRows = (await readFile(path.join(destination, 'moc', 'index.tsv'), 'utf8')).split('\n').filter(line => line && !line.startsWith('#'));
      assert.equal(indexedRows.length, detachedWorkerNoteCount + 1, 'the worker must finish the complete approved synthetic corpus after host closure');
      return { status: 'worker completed after MCP host exit', destination, sourceFile: path.join(source, 'plan.md') };
    }

    const taxonomyStatus = await waitFor(value => value.includes('Stage: taxonomy pending'));
    if (indexCrashAfter === 'backup') {
      const beforeRefresh = await readFile(path.join(destination, 'moc', 'index.tsv'));
      await writeFile(path.join(source, 'refresh-proof.md'), '# Refresh proof\nThe recovery report says the staged index was committed.\n');
      assert.match(await call('databrain_refresh'), /Indexing started in the background/);
      const refreshStatus = await waitFor(value => value.includes('Stage: taxonomy pending') && /Background job [0-9a-f-]+: complete/.test(value));
      assert.notDeepEqual(await readFile(path.join(destination, 'moc', 'index.tsv')), beforeRefresh, 'the refresh recovery must publish the new complete index after restoring the previous directory');
      assert.match(await call('databrain_search', { query: 'recovery report staged index committed' }), /refresh-proof\.md/);
      assert.doesNotMatch(refreshStatus, /indexing transaction.*failed/i);
    }
    if (indexCrashAfter) {
      const marker = path.join(destination, '.databrain', 'codex-index-transaction.tsv');
      let cleared = false;
      for (let attempt = 0; attempt < 1200; attempt += 1) {
        await call('databrain_setup_status');
        try { await lstat(marker); } catch (error) { if (error.code === 'ENOENT') { cleared = true; break; } throw error; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      assert(cleared, `index transaction marker must clear after recovery at ${indexCrashAfter}`);
      const recoveredJobId = JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8')).indexJob.id;
      await assert.rejects(lstat(path.join(destination, '.databrain', `index-transaction-${recoveredJobId}`)), { code: 'ENOENT' }, `index transaction workspace must clear after recovery at ${indexCrashAfter}`);
    }
    await assert.rejects(lstat(path.join(destination, '.databrain-codex-setup-pending')),
      { code: 'ENOENT' }, 'successful recovery clears the temporary setup marker');
    assert.match(taxonomyStatus, /apply clear folder mappings under the initial approval/);
    assert.doesNotMatch(taxonomyStatus, /wait for the user to confirm/i);
    const state = JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8'));
    assert.equal(state.client, 'codex');
    assert.equal(state.approvedScope.autoCategorize, true);
    assert.equal(state.roots.length, 1);
    assert.equal(readCodexLocator({ home }).status, 'connected');
    const original = await readFile(path.join(source, 'plan.md'));

    const proposals = await call('databrain_taxonomy_candidates');
    const folderId = proposals.match(/^(folder-[a-f0-9]+)\t/m)?.[1];
    assert(folderId, proposals);
    const applied = await request('tools/call', {
      name: 'databrain_apply_taxonomy',
      arguments: { assignments: [{ folder_id: folderId, categories: ['projects'] }] },
    });
    assert(!applied.error, JSON.stringify(applied.error));
    if (taxonomyCrashAfter) {
      await waitForChildExit(server);
      assert.equal(server.exitCode, 88, `taxonomy commit must crash at ${taxonomyCrashAfter}`);
      server = spawn(testLauncher || process.execPath, testLauncher ? [] : [serverScript, '--databrain-client', 'codex'], {
        env: { ...process.env, HOME: home, DATABRAIN_TEST_HOME: destination, DATABRAIN_TEST_SELECTION_FILE: selectionFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      replies.clear();
      attachReplies(server);
      await request('initialize', { protocolVersion: '2025-03-26' });
      server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      if (taxonomyCrashAfter === 'index') {
        assert.match(await call('databrain_setup_status'), /Stage: taxonomy pending/);
        const retryCandidates = await call('databrain_taxonomy_candidates');
        const retryFolderId = retryCandidates.match(/^(folder-[a-f0-9]+)\t/m)?.[1];
        assert(retryFolderId, retryCandidates);
        const retried = await request('tools/call', {
          name: 'databrain_apply_taxonomy',
          arguments: { assignments: [{ folder_id: retryFolderId, categories: ['projects'] }] },
        });
        assert(!retried.error, JSON.stringify(retried.error));
      } else {
        assert.match(await call('databrain_setup_status'), /Stage: relationships pending/);
        await assert.rejects(lstat(path.join(destination, '.databrain', 'codex-taxonomy-commit-pending.tsv')), { code: 'ENOENT' });
      }
      assert.match(await readFile(path.join(destination, 'moc', 'index.tsv'), 'utf8'), /\tprojects\t/);
      assert.match(await call('databrain_search', { query: 'release decision approved source files' }), /plan\.md/);
    }
    const relationshipStatus = await waitFor(value => value.includes('Stage: relationships pending'));
    assert.match(relationshipStatus, /no extra approval is needed/);
    const relationships = await call('databrain_build_relationships');
    assert(relationships.includes('started as job'));
    if (relationshipCrashAfter) {
      await waitForChildExit(server);
      assert.equal(server.exitCode, 89, `relationship commit must crash at ${relationshipCrashAfter}`);
      server = spawn(testLauncher || process.execPath, testLauncher ? [] : [serverScript, '--databrain-client', 'codex'], {
        env: { ...process.env, HOME: home, DATABRAIN_TEST_HOME: destination, DATABRAIN_TEST_SELECTION_FILE: selectionFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      replies.clear();
      attachReplies(server);
      await request('initialize', { protocolVersion: '2025-03-26' });
      server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      if (relationshipCrashAfter === 'report') {
        assert.match(await call('databrain_setup_status'), /Stage: relationships pending/);
        assert.match(await call('databrain_build_relationships'), /started as job/);
      } else {
        assert.match(await call('databrain_setup_status'), /Stage: verification pending/);
        await assert.rejects(lstat(path.join(destination, '.databrain', 'codex-relationship-commit-pending.tsv')), { code: 'ENOENT' });
      }
      assert.match(await readFile(path.join(destination, 'moc', 'relationships.tsv'), 'utf8'), /plan\.md/);
    }
    const finalStatus = await waitFor(value => value.includes('Stage: verification pending'));
    assert(finalStatus.includes(`Indexed rows: ${indexCrashAfter === 'backup' ? 2 : 1}`), `recovered setup row count after ${indexCrashAfter || 'normal'} indexing was wrong: ${finalStatus}`);
    if (indexCrashAfter) await assert.rejects(lstat(indexCrashFile), { code: 'ENOENT' }, `the ${indexCrashAfter} crash failpoint must be consumed exactly once`);
    assert.match(finalStatus, /Run databrain_verify_install/);
    const route = await call('databrain_abstain_check', {
      queries: ['what was the release decision?', 'which approved files should the release preserve?'],
    });
    assert.match(route, /plan\.md/, route);
    assert.match(route, /Read relevant evidence with databrain_read before answering or abstaining/);
    const pathMatch = route.match(/^\s*\d+\s+-?\d+(?:\.\d+)?\s+(.+)$/m);
    assert(pathMatch, route);
    const excerpt = await call('databrain_read', { path: pathMatch[1].trim() });
    assert.match(excerpt, /release decision is to preserve the approved source files/i, `read_path=${pathMatch[1]}; route=${route}`);
    assert.match(excerpt, /Evidence from: .*plan\.md/);
    const unsearched = await call('databrain_read', { path: '~/Documents/Project notes/unsearched.md' });
    assert.match(unsearched, /Search this source first/);
    const absent = await call('databrain_abstain_check', {
      queries: ['purple comet recipes for astronauts', 'violet telescope migration to mars'],
    });
    assert.match(absent, /DRY — none of these query variants returned approved-source candidates/);
    assert.deepEqual(await readFile(path.join(source, 'plan.md')), original);
    return { status: finalStatus, destination, sourceFile: path.join(source, 'plan.md') };
  } finally {
    server.kill('SIGTERM');
    await waitForChildExit(server);
  }
}

async function connectExistingCase(name, approved, crashAfter = null) {
  const home = path.join(await realpath(temp), name);
  const source = path.join(home, 'Documents', 'Project notes');
  const additionalSource = path.join(home, 'Documents', 'Additional notes');
  const parent = path.join(home, 'Documents');
  const destination = path.join(parent, 'DataBrain');
  const selectionFile = path.join(home, 'selection.json');
  const moc = path.join(destination, 'moc');
  await mkdir(path.join(home, 'Desktop'), { recursive: true });
  await mkdir(source, { recursive: true });
  await mkdir(additionalSource, { recursive: true });
  await mkdir(moc, { recursive: true });
  await writeFile(path.join(source, 'plan.md'), '# Existing plan\nThe fictional team keeps the launch checklist in the approved project folder.\n');
  await writeFile(path.join(additionalSource, 'decision.md'), '# Additional decision\nThe fictional team approved the offline review checklist for the second folder.\n');
  const sourceInfo = await lstat(source);
  const rootsPath = path.join(destination, '.source-roots');
  const identitiesPath = path.join(destination, '.databrain', 'root-identities.tsv');
  await mkdir(path.dirname(identitiesPath), { recursive: true, mode: 0o700 });
  await writeFile(rootsPath, `${source}\n`, { mode: 0o600 });
  await writeFile(identitiesPath, `${source}\t${sourceInfo.dev}:${sourceInfo.ino}\n`, { mode: 0o600 });
  const now = new Date().toISOString();
  await writeFile(path.join(destination, '.databrain', 'desktop-state.json'), `${JSON.stringify({
    stage: 'relationships pending',
    destinationParent: parent,
    roots: [source],
    rootIdentities: [{ path: source, dev: sourceInfo.dev, ino: sourceInfo.ino }],
    createdAt: now,
    updatedAt: now,
  }, null, 2)}\n`, { mode: 0o600 });
  const engine = path.resolve(here, '../..');
  const engineEnv = {
    ...process.env,
    HOME: home,
    NB_MOC_DIR: moc,
    NB_CANON_ROOTS_FILE: rootsPath,
    NB_CANON_ROOT_IDENTITIES_FILE: identitiesPath,
  };
  for (const script of ['build-index.sh', 'build-fts.sh']) {
    const built = spawnSync('/bin/bash', [path.join(engine, 'bin', script)], { encoding: 'utf8', env: engineEnv });
    assert.equal(built.status, 0, `${script} failed while creating the synthetic existing brain: ${built.stderr || built.stdout}`);
  }
  await writeFile(selectionFile, JSON.stringify({
    selections: { 'existing-databrain': [destination], sources: [additionalSource] },
    approved,
  }));
  const beforeIndex = await readFile(path.join(moc, 'index.tsv'));
  const beforeFts = await readFile(path.join(moc, 'fts.db'));
  let server = spawn(testLauncher || process.execPath, testLauncher ? [] : [serverScript, '--databrain-client', 'codex'], {
    env: { ...process.env, HOME: home, DATABRAIN_TEST_HOME: destination, DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      ...(crashAfter ? { DATABRAIN_TEST_SCOPE_CRASH_AFTER: crashAfter } : {}) },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let lines;
  const attachReplies = child => {
    lines = readline.createInterface({ input: child.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
  };
  attachReplies(server);
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 10000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const response = await request('tools/call', { name, arguments: args });
    assert(!response.error, JSON.stringify(response.error));
    return response.result.content?.[0]?.text || '';
  };
  const waitFor = async (predicate, attempts = 600) => {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const status = await call('databrain_setup_status');
      if (predicate(status)) return status;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for existing-brain connection: ${await call('databrain_setup_status')}`);
  };
  const holdMutationLock = async () => {
    const lockPath = path.join(destination, '.databrain', 'index-worker-lock.sqlite');
    const locker = spawn('sqlite3', ['-batch', '-bail', lockPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        locker.kill('SIGTERM');
        reject(new Error(`Timed out acquiring the synthetic shared DataBrain lock: ${output.trim() || 'sqlite3 produced no output.'}`));
      }, 5000);
      locker.stdout.setEncoding('utf8');
      locker.stderr.setEncoding('utf8');
      locker.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('TEST_DATABRAIN_LOCK_HELD')) { clearTimeout(timer); resolve(); }
      });
      locker.stderr.on('data', chunk => { output += chunk; });
      locker.once('error', error => { clearTimeout(timer); reject(error); });
      locker.once('close', code => {
        if (code !== 0 && !output.includes('TEST_DATABRAIN_LOCK_HELD')) {
          clearTimeout(timer);
          reject(new Error(`Could not acquire the synthetic shared DataBrain lock: ${output}`));
        }
      });
    });
    locker.stdin.write("PRAGMA busy_timeout=0;\nBEGIN EXCLUSIVE;\nSELECT 'TEST_DATABRAIN_LOCK_HELD';\n");
    await ready;
    return async () => {
      locker.stdin.end('ROLLBACK;\n.quit\n');
      if (locker.exitCode === null) await new Promise(resolve => locker.once('exit', resolve));
    };
  };
  try {
    const initialized = await request('initialize', { protocolVersion: '2025-03-26' });
    assert.match(initialized.result.instructions, /databrain_connect_existing/);
    const listed = await request('tools/list');
    assert(listed.result.tools.some(tool => tool.name === 'databrain_connect_existing'));
    assert.match(await call('databrain_connect_existing'), /native chooser is open/);
    if (crashAfter) {
      await waitForChildExit(server);
      assert.equal(server.exitCode, 86, `reconnect must crash at ${crashAfter}`);
      server = spawn(testLauncher || process.execPath, testLauncher ? [] : [serverScript, '--databrain-client', 'codex'], {
        env: { ...process.env, HOME: home, DATABRAIN_TEST_HOME: destination, DATABRAIN_TEST_SELECTION_FILE: selectionFile },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      replies.clear();
      attachReplies(server);
      await request('initialize', { protocolVersion: '2025-03-26' });
      server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
      assert.match(await call('databrain_setup_status'), /Stage:/);
      assert.equal(readCodexLocator({ home }).status, crashAfter === 'reconnect-marker' ? 'missing' : 'connected');
      assert.deepEqual(await readFile(path.join(moc, 'index.tsv')), beforeIndex, `reconnect recovery after ${crashAfter} must preserve the existing index`);
      assert.deepEqual(await readFile(path.join(moc, 'fts.db')), beforeFts, `reconnect recovery after ${crashAfter} must preserve ranked search`);
      const recoveredState = JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8'));
      assert.equal(recoveredState.codexAccess?.generation, crashAfter === 'reconnect-marker' ? undefined : 1);
      await assert.rejects(lstat(path.join(destination, '.databrain', CODEX_SCOPE_COMMIT_MARKER_FOR_TEST)), { code: 'ENOENT' });
      if (crashAfter === 'reconnect-marker') {
        assert.match(await call('databrain_connect_existing'), /native chooser is open/);
        assert.match(await waitFor(value => value.includes('connect existing DataBrain: complete')), /reused its current index/);
      } else {
        assert.match(await call('databrain_search', { query: 'launch checklist project folder' }), /plan\.md/, `reconnect recovery after ${crashAfter}`);
      }
      return `reconnect recovery after ${crashAfter}`;
    }
    const status = await waitFor(value => value.includes(`connect existing DataBrain: ${approved ? 'complete' : 'cancelled'}`));
    assert.deepEqual(await readFile(path.join(moc, 'index.tsv')), beforeIndex, 'connecting must not rewrite the existing index');
    assert.deepEqual(await readFile(path.join(moc, 'fts.db')), beforeFts, 'connecting must not rebuild ranked search');
    const statePath = path.join(destination, '.databrain', 'desktop-state.json');
    const state = JSON.parse(await readFile(statePath, 'utf8'));
    if (!approved) {
      assert.match(status, /existing DataBrain and its current permissions were left unchanged/);
      assert.equal(state.client, undefined);
      assert.equal(state.codexAccess, undefined);
      assert.equal(readCodexLocator({ home }).status, 'missing');
      return status;
    }
    assert.match(status, /reused its current index/);
    assert.equal(state.client, undefined, 'adopting a Claude brain must preserve its original client identity');
    assert.equal(state.codexAccess.recursiveRead, true);
    assert.equal(state.codexAccess.localDerivedWrites, true);
    assert.equal(readCodexLocator({ home }).status, 'connected');
    const found = await call('databrain_search', { query: 'launch checklist project folder' });
    assert.match(found, /plan\.md/, found);
    const beforeRoots = await readFile(rootsPath);
    const beforeIdentities = await readFile(identitiesPath);
    const releaseLock = await holdMutationLock();
    try {
      assert.match(await call('databrain_add_sources'), /native source chooser and exact-scope permission dialog/);
      const busy = await waitFor(value => value.includes('add source folders: failed'));
      assert.match(busy, /Another DataBrain client is indexing or changing this brain/);
      assert.deepEqual(await readFile(rootsPath), beforeRoots, 'a busy shared lock must prevent grant publication');
      assert.deepEqual(await readFile(identitiesPath), beforeIdentities, 'a busy shared lock must prevent identity publication');
      const unchanged = JSON.parse(await readFile(statePath, 'utf8'));
      assert.deepEqual(unchanged.roots, [source]);
      assert.equal(unchanged.codexAccess.generation, 1);
      assert.equal(readCodexLocator({ home }).generation, 1);
    } finally {
      await releaseLock();
    }
    assert.match(await call('databrain_add_sources'), /native source chooser and exact-scope permission dialog/);
    await waitFor(value => value.includes('Stage: taxonomy pending'), 2400);
    const updated = JSON.parse(await readFile(statePath, 'utf8'));
    assert.equal(updated.client, undefined, 'source changes must preserve the Claude brain identity');
    assert(updated.roots.includes(additionalSource));
    assert.equal(updated.codexAccess.generation, 2);
    assert.equal(readCodexLocator({ home }).generation, 2);
    const added = await call('databrain_search', { query: 'offline review checklist second folder' });
    assert.match(added, /decision\.md/, added);
    return status;
  } finally {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  }
}

async function initialSetupCrashRecoveryCase(crashAfter) {
  const home = path.join(await realpath(temp), `initial-setup-crash-${crashAfter}`);
  const parent = path.join(home, 'Desktop');
  const destination = path.join(parent, 'DataBrain');
  const source = path.join(home, 'Documents', 'Approved notes');
  const selectionFile = path.join(home, 'selection.json');
  await mkdir(parent, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'decision.md'), '# Decision\nThe synthetic team retains the approved local source files.\n');
  await writeFile(selectionFile, JSON.stringify({ selections: { sources: [source], 'destination-parent': [parent] }, approved: true }));

  const launch = point => spawn(process.execPath, [serverScript, '--databrain-client', 'codex'], {
    env: {
      ...process.env,
      HOME: home,
      DATABRAIN_TEST_HOME: destination,
      DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      ...(point ? { DATABRAIN_TEST_SETUP_CRASH_AFTER: point } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const rpc = server => {
    const replies = new Map();
    const lines = readline.createInterface({ input: server.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
    let id = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => { replies.delete(requestId); reject(new Error(`Timed out: ${method}`)); }, 10000);
      replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
    const call = async name => {
      const response = await request('tools/call', { name, arguments: {} });
      assert(!response.error, JSON.stringify(response.error));
      return response.result.content?.[0]?.text || '';
    };
    return { request, call, notifyInitialized: () => server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n') };
  };

  const crashing = launch(crashAfter);
  const crashClient = rpc(crashing);
  await crashClient.request('initialize', { protocolVersion: '2025-03-26' });
  crashClient.notifyInitialized();
  assert.match(await crashClient.call('databrain_setup_start'), /initial setup permission flow is open/);
  await waitForChildExit(crashing);
  assert.equal(crashing.exitCode, 87, `initial setup must crash at the requested ${crashAfter} boundary`);

  const recovering = launch(null);
  const recoveryClient = rpc(recovering);
  try {
    await recoveryClient.request('initialize', { protocolVersion: '2025-03-26' });
    recoveryClient.notifyInitialized();
    if (crashAfter === 'locator') {
      assert.equal(readCodexLocator({ home }).status, 'connected');
      assert.match(await recoveryClient.call('databrain_setup_status'), /Stage: sources selected/);
      await assert.rejects(lstat(path.join(destination, CODEX_SETUP_MARKER_FOR_TEST)), { code: 'ENOENT' });
      assert.match(await recoveryClient.call('databrain_setup_run'), /Indexing started in the background/);
    } else {
      assert.equal(readCodexLocator({ home }).status, 'missing');
      assert.match(await recoveryClient.call('databrain_setup_start'), /initial setup permission flow is open/);
    }

    let finalStatus = '';
    for (let attempt = 0; attempt < 1200; attempt += 1) {
      finalStatus = await recoveryClient.call('databrain_setup_status');
      if (finalStatus.includes('Stage: taxonomy pending')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.match(finalStatus, /Stage: taxonomy pending/, `setup did not recover after ${crashAfter}: ${finalStatus}`);
    assert.equal(readCodexLocator({ home }).status, 'connected');
    await assert.rejects(lstat(path.join(destination, CODEX_SETUP_MARKER_FOR_TEST)), { code: 'ENOENT' });
    assert.deepEqual(JSON.parse(await readFile(path.join(destination, '.databrain', 'desktop-state.json'), 'utf8')).roots, [source]);
  } finally {
    recovering.kill('SIGTERM');
    await waitForChildExit(recovering);
  }
}

async function scopeCrashRecoveryCase(crashAfter) {
  const home = path.join(await realpath(temp), `scope-crash-recovery-${crashAfter}`);
  const destination = path.join(home, 'Desktop', 'DataBrain');
  const firstRoot = path.join(home, 'Documents', 'First');
  const secondRoot = path.join(home, 'Documents', 'Second');
  const selectionFile = path.join(home, 'selection.json');
  await mkdir(destination, { recursive: true, mode: 0o700 });
  await mkdir(firstRoot, { recursive: true });
  await mkdir(secondRoot, { recursive: true });
  const firstInfo = await lstat(firstRoot);
  const secondInfo = await lstat(secondRoot);
  const stateDir = path.join(destination, '.databrain');
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const oldState = {
    client: 'codex',
    stage: 'sources selected',
    destinationParent: path.dirname(destination),
    roots: [firstRoot],
    rootIdentities: [{ path: firstRoot, dev: firstInfo.dev, ino: firstInfo.ino }],
    approvedScope: { version: 1, generation: 1, recursiveRead: true, localDerivedWrites: true, autoCategorize: true },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const grantFile = path.join(destination, '.source-roots');
  const identityFile = path.join(stateDir, 'root-identities.tsv');
  const stateFile = path.join(stateDir, 'desktop-state.json');
  await writeFile(grantFile, `${firstRoot}\n`, { mode: 0o600 });
  await writeFile(identityFile, `${firstRoot}\t${firstInfo.dev}:${firstInfo.ino}\n`, { mode: 0o600 });
  await writeFile(stateFile, `${JSON.stringify(oldState, null, 2)}\n`, { mode: 0o600 });
  await writeFile(selectionFile, JSON.stringify({ selections: { sources: [secondRoot] }, approved: true }));
  await writeCodexLocator({ home, destination, generation: 1 });

  const launch = crashAfter => spawn(process.execPath, [serverScript, '--databrain-client', 'codex'], {
    env: {
      ...process.env,
      HOME: home,
      DATABRAIN_TEST_HOME: destination,
      DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      ...(crashAfter ? { DATABRAIN_TEST_SCOPE_CRASH_AFTER: crashAfter } : {}),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const sendCall = async (server, name) => {
    const replies = new Map();
    const lines = readline.createInterface({ input: server.stdout });
    lines.on('line', line => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
    let id = 0;
    const request = (method, params = {}) => new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 10000);
      replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
    await request('initialize', { protocolVersion: '2025-03-26' });
    server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    return request('tools/call', { name, arguments: {} });
  };

  const crashing = launch(crashAfter);
  const crashExit = waitForChildExit(crashing);
  await sendCall(crashing, 'databrain_add_sources');
  await crashExit;
  assert.equal(crashing.exitCode, 86, `the fixture must stop after the ${crashAfter} commit boundary`);
  const stateCommitted = ['state', 'pruned', 'locator'].includes(crashAfter);
  const committedRoots = stateCommitted ? [firstRoot, secondRoot] : [firstRoot];
  const committedGeneration = stateCommitted ? 2 : 1;
  const grantAtCrash = crashAfter === 'marker' ? [firstRoot] : [firstRoot, secondRoot];
  assert.deepEqual((await readFile(grantFile, 'utf8')).trim().split('\n'), grantAtCrash);
  assert.deepEqual(JSON.parse(await readFile(stateFile, 'utf8')).roots, committedRoots);
  assert.equal(await readFile(path.join(stateDir, CODEX_SCOPE_COMMIT_MARKER_FOR_TEST), 'utf8').then(() => true, () => false), true);

  const recovering = launch(null);
  try {
    const lines = readline.createInterface({ input: recovering.stdout });
    const replies = new Map();
    lines.on('line', line => {
      const message = JSON.parse(line);
      replies.get(message.id)?.(message);
    });
    let requestId = 0;
    const status = () => new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => { replies.delete(id); reject(new Error('Timed out: scope recovery status')); }, 10000);
      replies.set(id, message => { clearTimeout(timer); replies.delete(id); resolve(message); });
      recovering.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'databrain_setup_status', arguments: {} } })}\n`);
    });
    const response = await status();
    assert(!response.error, JSON.stringify(response.error));
    if (!stateCommitted) assert.match(response.result.content?.[0]?.text || '', /Stage: sources selected/);
    assert.deepEqual((await readFile(grantFile, 'utf8')).trim().split('\n'), committedRoots);
    const expectedIdentities = committedRoots.map(root => {
      const info = root === firstRoot ? firstInfo : secondInfo;
      return `${root}\t${info.dev}:${info.ino}`;
    }).join('\n') + '\n';
    assert.equal(await readFile(identityFile, 'utf8'), expectedIdentities);
    const recoveredState = JSON.parse(await readFile(stateFile, 'utf8'));
    assert.deepEqual(recoveredState.roots, committedRoots);
    assert.equal((recoveredState.approvedScope || recoveredState.codexAccess).generation, committedGeneration);
    assert.equal(readCodexLocator({ home }).generation, committedGeneration);
    await assert.rejects(lstat(path.join(stateDir, CODEX_SCOPE_COMMIT_MARKER_FOR_TEST)), { code: 'ENOENT' });
    if (stateCommitted) {
      let finalStatus = response.result.content?.[0]?.text || '';
      for (let attempt = 0; attempt < 1200 && !finalStatus.includes('Stage: taxonomy pending'); attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 50));
        const next = await status();
        assert(!next.error, JSON.stringify(next.error));
        finalStatus = next.result.content?.[0]?.text || '';
      }
      assert.match(finalStatus, /Stage: taxonomy pending/, 'the committed scope must resume indexing after crash recovery');
    }
  } finally {
    recovering.kill('SIGTERM');
    await waitForChildExit(recovering);
  }
}

try {
  const denied = await launchCase('denied', false);
  assert(denied.status.includes('no DataBrain was created'));
  const approved = await launchCase('approved', true);
  assert(approved.status.includes('Stage: verification pending'));
  const recovered = await launchCase('recovered', true, true);
  assert(recovered.status.includes('Stage: verification pending'));
  const resumed = await launchCase('resumed', true, false, true);
  assert(resumed.status.includes('Stage: verification pending'));
  for (const point of ['index', 'marker', 'rebuild', 'fts', 'state']) {
    const recoveredTaxonomy = await launchCase(`taxonomy-crash-${point}`, true, false, false, false, point);
    assert(recoveredTaxonomy.status.includes('Stage: verification pending'));
  }
  for (const point of ['report', 'marker', 'state']) {
    const recoveredRelationships = await launchCase(`relationship-crash-${point}`, true, false, false, false, null, point);
    assert(recoveredRelationships.status.includes('Stage: verification pending'));
  }
  for (const point of ['building', 'publish', 'state', 'backup']) {
    const recoveredIndex = await launchCase(`index-transaction-crash-${point}`, true, false, false, false, null, null, point);
    assert(recoveredIndex.status.includes('Stage: verification pending'));
  }
  if (process.env.DATABRAIN_TEST_CLOSE_HOST_DURING_INDEXING === '1') {
    const hostClosed = await launchCase('host-closed', true, false, false, true);
    assert.equal(hostClosed.status, 'worker completed after MCP host exit');
  }
  for (const point of ['marker', 'roots', 'identities', 'state', 'locator']) await initialSetupCrashRecoveryCase(point);
  await connectExistingCase('existing-approved', true);
  await connectExistingCase('existing-crash-before-state', true, 'reconnect-marker');
  await connectExistingCase('existing-crash-after-state', true, 'reconnect-state');
  await connectExistingCase('existing-crash-after-locator', true, 'reconnect-locator');
  for (const point of ['marker', 'roots', 'identities', 'state', 'pruned', 'locator']) await scopeCrashRecoveryCase(point);
  await connectExistingCase('existing-declined', false);
  const workerCloseResult = process.env.DATABRAIN_TEST_CLOSE_HOST_DURING_INDEXING === '1'
    ? `, live worker survival after MCP host exit (${detachedWorkerNoteCount + 1} indexed files)` : '';
  console.log(`PASS: Codex first-run consent, initial-setup recovery at five file-commit boundaries, source-scope/reconnect/taxonomy/relationship/index-transaction recovery, dead-worker restart${workerCloseResult}, local indexing/relationships, existing-brain approval/decline and index preservation, and source preservation.`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
