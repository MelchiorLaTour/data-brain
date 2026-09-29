import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const [engine, dataHome, rootsFile, sourceRoot] = process.argv.slice(2);
assert(engine && dataHome && rootsFile && sourceRoot, 'usage: test_mcp_data_route.mjs ENGINE DATA_HOME ROOTS_FILE SOURCE_ROOT');
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const roots = (await fs.readFile(rootsFile, 'utf8')).trim().split('\n');
const retainedRoot = roots.find(root => root !== sourceRoot);
assert(retainedRoot, 'fixture needs a second source root for revocation');
const selectionFile = `${dataHome}.test-selection`;
const openRace = {
  target: path.join(sourceRoot, 'decision record.md'),
  arm: `${dataHome}.open-race-arm`,
  signal: `${dataHome}.open-race-signal`,
  release: `${dataHome}.open-race-release`,
};
const rootRace = {
  target: path.join(sourceRoot, 'decision record.md'),
  arm: `${dataHome}.root-race-arm`,
  signal: `${dataHome}.root-race-signal`,
  release: `${dataHome}.root-race-release`,
};
const noteRace = {
  target: path.join(sourceRoot, `${new Date().toISOString().slice(0, 10)} Raced capture fixture.md`),
  arm: `${dataHome}.note-race-arm`,
  signal: `${dataHome}.note-race-signal`,
  release: `${dataHome}.note-race-release`,
};
const cloudFixtureRoot = path.join(path.dirname(dataHome), 'Cloud placeholder source');
const cloudFixture = path.join(cloudFixtureRoot, 'cloud-placeholder-fixture.txt');
const runtimeBin = path.join(path.dirname(serverScript), 'runtime', 'bin');
const cloudLsShim = path.join(runtimeBin, 'ls');
const cloudStatShim = path.join(runtimeBin, 'stat');
let cloudShimsInstalled = false;
await fs.writeFile(selectionFile, `${retainedRoot}\n`, { mode: 0o600 });
let server;
let stderr = '';
const waiters = new Map();
function startServer() {
  const child = spawn(process.execPath, ['--import', path.join(here, 'pause-open-preload.mjs'), serverScript], {
    env: {
      ...process.env,
      DATABRAIN_ENGINE_DIR: engine,
      DATABRAIN_TEST_HOME: dataHome,
      DATABRAIN_TEST_SELECTION_FILE: selectionFile,
      DATABRAIN_TEST_OPEN_PATH: openRace.target,
      DATABRAIN_TEST_OPEN_ARM: openRace.arm,
      DATABRAIN_TEST_OPEN_SIGNAL: openRace.signal,
      DATABRAIN_TEST_OPEN_RELEASE: openRace.release,
      DATABRAIN_TEST_REALPATH_PATH: rootRace.target,
      DATABRAIN_TEST_REALPATH_ARM: rootRace.arm,
      DATABRAIN_TEST_REALPATH_SIGNAL: rootRace.signal,
      DATABRAIN_TEST_REALPATH_RELEASE: rootRace.release,
      DATABRAIN_TEST_NOTE_OPEN_PATH: noteRace.target,
      DATABRAIN_TEST_NOTE_OPEN_ARM: noteRace.arm,
      DATABRAIN_TEST_NOTE_OPEN_SIGNAL: noteRace.signal,
      DATABRAIN_TEST_NOTE_OPEN_RELEASE: noteRace.release,
      DATABRAIN_TEST_NOTE_PRELOAD: path.join(here, 'pause-open-preload.mjs'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', part => { stderr += part; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    waiters.get(message.id)?.(message);
  });
  return child;
}
server = startServer();

function request(id, method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`MCP request timed out: ${method}`)), 5000);
    waiters.set(id, message => { clearTimeout(timer); waiters.delete(id); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}

try {
  assert(roots.includes(sourceRoot), 'fixture root is not in selected-root grant');
  await fs.mkdir(path.join(dataHome, '.databrain'), { recursive: true, mode: 0o700 });
  await fs.rm(path.join(dataHome, 'moc'), { recursive: true, force: true });
  await fs.writeFile(path.join(dataHome, '.source-roots'), `${roots.join('\n')}\n`, { mode: 0o600 });
  await fs.writeFile(path.join(dataHome, '.databrain', 'desktop-state.json'), JSON.stringify({
    stage: 'sources selected', roots,
    rootIdentities: roots.map(root => {
      const info = lstatSync(root);
      return { path: root, dev: info.dev, ino: info.ino };
    }),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  await fs.writeFile(path.join(dataHome, '.databrain', 'root-identities.tsv'), roots.map(root => {
    const info = lstatSync(root);
    return `${root}\t${info.dev}:${info.ino}`;
  }).join('\n') + '\n', { mode: 0o600 });

  const init = await request(1, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(init.result.serverInfo.name, 'databrain');
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const initialStatus = await request(90, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
  assert(initialStatus.result.content[0].text.includes('Stage: sources selected'), `fresh setup did not resume from selected roots: ${initialStatus.result.content[0].text}`);
  const extractScript = path.join(engine, 'bin', 'extract.sh');
  const originalExtract = await fs.readFile(extractScript);
  const extractReal = `${extractScript}.test-original`;
  const cancelMarker = path.join(engine, 'bin', '.cancel-once');
  await fs.writeFile(extractReal, originalExtract, { mode: 0o600 });
  await fs.writeFile(extractScript, '#!/bin/bash\nset -eu\nhere="$(cd "$(dirname "$0")" && pwd)"\nmarker="$here/.cancel-once"\nif [ ! -e "$marker" ]; then : > "$marker"; sleep 30; fi\nexec /bin/bash "$here/extract.sh.test-original" "$@"\n', { mode: 0o755 });
  await fs.chmod(extractScript, 0o755);
  const setup = await request(91, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(setup.result.content[0].text.includes('Indexing started'), `initial indexing did not start: ${setup.result.content[0].text}`);
  let indexingJobId = setup.result.content[0].text.match(/job ([0-9a-f-]{36})/)?.[1];
  assert(indexingJobId, `initial indexing did not return a job ID: ${setup.result.content[0].text}`);
  let extractionWaitStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1100 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    extractionWaitStatus = reply.result.content[0].text;
    if (extractionWaitStatus.includes('Extracting supported documents')) {
      try { await fs.lstat(cancelMarker); break; } catch {}
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(extractionWaitStatus.includes('Extracting supported documents'), `indexing did not reach the cancellable extraction step: ${extractionWaitStatus}`);
  const cancelIndexing = await request(19, 'tools/call', { name: 'databrain_cancel_job', arguments: { job_id: indexingJobId } });
  assert(cancelIndexing.result.content[0].text.includes('Cancellation requested'), `indexing cancellation was not accepted: ${cancelIndexing.result.content[0].text}`);
  let cancelledIndexingStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1200 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    cancelledIndexingStatus = reply.result.content[0].text;
    if (cancelledIndexingStatus.includes('initial indexing: cancelled')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(cancelledIndexingStatus.includes('Stage: indexing') && cancelledIndexingStatus.includes('initial indexing: cancelled'), `cancelled indexing did not preserve a resumable checkpoint: ${cancelledIndexingStatus}`);
  await fs.writeFile(extractScript, originalExtract);
  await fs.rm(extractReal, { force: true });
  await fs.rm(cancelMarker, { force: true });
  await fs.chmod(extractScript, 0o755);
  const interruptedServer = server;
  const interruptedClose = new Promise(resolve => interruptedServer.once('close', resolve));
  interruptedServer.kill('SIGTERM');
  await interruptedClose;
  server = startServer();
  const resumedInit = await request(1300, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(resumedInit.result.serverInfo.name, 'databrain');
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const restartStatus = await request(1301, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
  assert(restartStatus.result.content[0].text.includes('Stage: indexing') && restartStatus.result.content[0].text.includes('rerun databrain_setup_run'), `server restart lost the interrupted setup checkpoint: ${restartStatus.result.content[0].text}`);
  const resumedSetup = await request(20, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(resumedSetup.result.content[0].text.includes('Indexing started'), `cancelled setup could not resume: ${resumedSetup.result.content[0].text}`);
  let setupStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(100 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    setupStatus = reply.result.content[0].text;
    if (setupStatus.includes('Stage: taxonomy pending')) break;
    if (setupStatus.includes('initial indexing: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(setupStatus.includes('Stage: taxonomy pending'), `initial indexing did not finish: ${setupStatus}`);
  assert(setupStatus.includes('Review the reported gaps and retry with databrain_refresh'), `indexing did not explain how to resolve the fixture's unreadable-file gap: ${setupStatus}`);
  assert(setupStatus.includes('File inventory: 6 indexed, 0 eligible missing from index, 1 unsupported; unreadable 1'), `file inventory did not reconcile selected and unreadable files: ${setupStatus}`);
  const healthReply = await request(1501, 'tools/call', { name: 'databrain_health', arguments: {} });
  const healthReport = healthReply.result.content[0].text;
  assert(healthReport.includes('Index records: 6; missing 0; unsafe 0; outside approved roots 0.'), `health check did not reconcile selected-root index paths: ${healthReport}`);
  assert(healthReport.includes('File inventory: 6 indexed; 0 eligible missing; 1 unsupported; unreadable 1; placeholders 0; empty 0; traversal errors 0.'), `health check did not report the selected-root inventory: ${healthReport}`);
  assert(healthReport.includes('Ranked search database: 6 rows; quick_check ok.'), `health check did not validate the ranked-search database: ${healthReport}`);
  assert(healthReport.includes('Source freshness: current.'), `healthy selected-root freshness was not reported: ${healthReport}`);
  const inventoryAuditReply = await request(1506, 'tools/call', { name: 'databrain_verify_install', arguments: {} });
  const inventoryAudit = inventoryAuditReply.result.content[0].text;
  assert.match(inventoryAudit, /PARTIAL: Selected-source health .*exceptions unsupported 1, unreadable 1, cloud placeholders 0, empty 0, traversal errors 0/, `install audit did not disclose inventory exceptions as partial health: ${inventoryAudit}`);
  assert(!inventoryAudit.includes('neverindexunreadabletoken'), 'install audit disclosed unreadable source contents');
  const inventoryBeforeHealth = await fs.readFile(path.join(dataHome, 'moc', 'inventory.tsv'), 'utf8');
  const addedFreshnessFile = path.join(sourceRoot, 'freshness-added-fixture.md');
  await fs.writeFile(addedFreshnessFile, 'Synthetic newly added file.');
  const staleHealth = await request(1502, 'tools/call', { name: 'databrain_health', arguments: {} });
  assert(staleHealth.result.content[0].text.includes('Source freshness: stale: 1 added, 0 deleted, 0 changed, 0 without baseline.'), `health did not detect an added file: ${staleHealth.result.content[0].text}`);
  assert.equal(await fs.readFile(path.join(dataHome, 'moc', 'inventory.tsv'), 'utf8'), inventoryBeforeHealth, 'read-only health rewrote the generated inventory');
  await fs.unlink(addedFreshnessFile);
  const restoredHealth = await request(1505, 'tools/call', { name: 'databrain_health', arguments: {} });
  assert(restoredHealth.result.content[0].text.includes('Source freshness: current.'), `health did not recover after the added file was removed: ${restoredHealth.result.content[0].text}`);
  const unreadableFixture = path.join(retainedRoot, 'unreadable.txt');
  await fs.chmod(unreadableFixture, 0o644);
  try {
    const cleanRefresh = await request(1503, 'tools/call', { name: 'databrain_refresh', arguments: {} });
    assert(cleanRefresh.result.content[0].text.includes('Indexing started'), `clean status-message refresh did not start: ${cleanRefresh.result.content[0].text}`);
    let cleanStatus = '';
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const reply = await request(1600 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
      cleanStatus = reply.result.content[0].text;
      if (cleanStatus.includes('refresh: complete')) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(cleanStatus.includes('refresh: complete'), `clean fixture refresh did not finish: ${cleanStatus}`);
    assert(cleanStatus.includes('give each folder group a broad useful lowercase label under the initial approval'), `clean indexing did not show the real category-review next step: ${cleanStatus}`);
  } finally {
    await fs.chmod(unreadableFixture, 0o000);
  }
  const unreadableRefresh = await request(1504, 'tools/call', { name: 'databrain_refresh', arguments: {} });
  assert(unreadableRefresh.result.content[0].text.includes('Indexing started'), `refresh after restoring the unreadable fixture did not start: ${unreadableRefresh.result.content[0].text}`);
  let unreadableRefreshStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1650 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    unreadableRefreshStatus = reply.result.content[0].text;
    const refreshJobs = unreadableRefreshStatus.split('\n').filter(line => line.startsWith('refresh:'));
    if (refreshJobs.at(-1)?.includes('refresh: complete') || refreshJobs.at(-1)?.includes('refresh: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(unreadableRefreshStatus.includes('refresh: complete') && unreadableRefreshStatus.includes('unreadable 1'), `refresh did not reconcile the restored unreadable fixture: ${unreadableRefreshStatus}`);
  const ftsPath = path.join(dataHome, 'moc', 'fts.db');
  const savedFtsPath = `${ftsPath}.health-fixture`;
  await fs.rename(ftsPath, savedFtsPath);
  await fs.writeFile(ftsPath, 'synthetic corrupt SQLite database');
  try {
    const corruptHealth = await request(1502, 'tools/call', { name: 'databrain_health', arguments: {} });
    const corruptReport = corruptHealth.result.content[0].text;
    assert(corruptReport.includes('Ranked search database: check failed.'), `health check did not report the corrupt ranked-search database: ${corruptReport}`);
    assert(corruptReport.includes('Next: resolve the reported issue'), `health check treated a failed SQLite integrity check as healthy: ${corruptReport}`);
  } finally {
    await fs.rm(ftsPath, { force: true });
    await fs.rename(savedFtsPath, ftsPath);
  }
  const indexPath = path.join(dataHome, 'moc', 'index.tsv');
  let initialIndex = await fs.readFile(indexPath, 'utf8');
  assert(initialIndex.includes('decision record.md') && initialIndex.includes('analysis.docx'), 'first-run setup did not record both selected roots and supported files');
  const terminalMoc = path.join(dataHome, 'terminal-parity-moc');
  const terminalEnv = {
    ...process.env,
    NB_MOC_DIR: terminalMoc,
    NB_CANON_ROOTS_FILE: rootsFile,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  };
  const runTerminal = (script, ...args) => {
    const result = spawnSync('/bin/bash', [path.join(engine, 'bin', script), ...args], {
      encoding: 'utf8', env: terminalEnv,
    });
    assert.equal(result.status, 0, `terminal ${script} failed during independent parity run: ${result.stderr}`);
    return result.stdout;
  };
  await fs.mkdir(terminalMoc, { recursive: true });
  runTerminal('build-index.sh');
  for (const root of roots) runTerminal('ingest-root.sh', root);
  runTerminal('extract.sh');
  runTerminal('inventory.sh');
  runTerminal('rebuild.sh');
  runTerminal('build-fts.sh');
  runTerminal('refresh.sh', 'parity');
  const nonHeaderRows = text => text.split('\n').filter(line => line && !line.startsWith('#')).sort();
  const appMoc = path.join(dataHome, 'moc');
  const appIndexRows = nonHeaderRows(await fs.readFile(path.join(appMoc, 'index.tsv'), 'utf8'));
  const terminalIndexRows = nonHeaderRows(await fs.readFile(path.join(terminalMoc, 'index.tsv'), 'utf8'));
  const unreadableRow = line => line.startsWith(`${unreadableFixture}\t`);
  const appUnreadable = appIndexRows.find(unreadableRow);
  const terminalUnreadable = terminalIndexRows.find(unreadableRow);
  assert(appUnreadable && terminalUnreadable, 'independent routes must retain the unreadable file inventory row');
  assert.notEqual(appUnreadable.split('\t')[3], '-', 'app should retain keywords selected while the fixture was readable');
  assert.equal(terminalUnreadable.split('\t')[3], '-', 'a cold terminal index must not invent keywords for an unreadable file');
  assert.deepEqual(appIndexRows.filter(line => !unreadableRow(line)), terminalIndexRows.filter(line => !unreadableRow(line)), 'independent app and terminal runs differed outside the file whose permissions changed after app ingestion');
  assert.deepEqual(
    nonHeaderRows(await fs.readFile(path.join(appMoc, 'inventory.tsv'), 'utf8')),
    nonHeaderRows(await fs.readFile(path.join(terminalMoc, 'inventory.tsv'), 'utf8')),
    'independent app and terminal runs reported different inventory states',
  );
  const appExtractionRows = nonHeaderRows(await fs.readFile(path.join(appMoc, 'extract-report.tsv'), 'utf8'));
  const terminalExtractionRows = nonHeaderRows(await fs.readFile(path.join(terminalMoc, 'extract-report.tsv'), 'utf8'));
  assert.deepEqual(appExtractionRows.filter(line => !unreadableRow(line)), terminalExtractionRows.filter(line => !unreadableRow(line)), 'independent app and terminal extraction outcomes differed outside the unreadable fixture');
  assert(!appExtractionRows.some(unreadableRow) && terminalExtractionRows.some(line => unreadableRow(line) && /\t(?:open_failed|read_failed)$/.test(line)), 'the cold terminal pass should report its denied keyword read without copying the unreadable body');
  const sidecarRows = async moc => Promise.all((await fs.readdir(path.join(moc, 'extracted'))).sort().map(async name => [name, await fs.readFile(path.join(moc, 'extracted', name), 'utf8')]));
  assert.deepEqual(await sidecarRows(appMoc), await sidecarRows(terminalMoc), 'independent app and terminal runs extracted different source text');
  const missingPdf = path.join(retainedRoot, 'missing.pdf');
  const conflictPath = path.join(sourceRoot, 'conflict.md');
  const symlinkPath = path.join(sourceRoot, 'symlink-note.md');
  const symlinkTarget = path.join(dataHome, 'unapproved relationship target.md');
  await fs.writeFile(conflictPath, 'A different synthetic note with a conflicting title.\n');
  await fs.writeFile(symlinkTarget, '# Project note\nA synthetic project note about account recovery.\n');
  await fs.symlink(symlinkTarget, symlinkPath);
  await fs.appendFile(indexPath, `${missingPdf}\tmissing synthetic PDF\t-\t-\n${conflictPath}\tDecision record\t-\tfixture\n${symlinkPath}\tunsafe source link\t-\t-\n`);
  const refresh = await request(92, 'tools/call', { name: 'databrain_refresh', arguments: {} });
  assert(refresh.result.content[0].text.includes('Indexing started'), `exception refresh did not start: ${refresh.result.content[0].text}`);
  let exceptionStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(220 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    exceptionStatus = reply.result.content[0].text;
    if (exceptionStatus.includes('Stage: taxonomy pending') && exceptionStatus.includes('Extraction exceptions: 1 (missing.pdf)')) break;
    if (exceptionStatus.includes('refresh: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(exceptionStatus.includes('Extraction exceptions: 1 (missing.pdf)'), `status hid the extraction exception or recovery action: ${exceptionStatus}`);
  assert(exceptionStatus.includes('databrain_refresh'), 'status did not tell the user how to retry after an extraction exception');
  // Rebuild the terminal artifacts independently from the same indexed rows the app now serves.
  await fs.copyFile(indexPath, path.join(terminalMoc, 'index.tsv'));
  runTerminal('extract.sh');
  runTerminal('inventory.sh');
  runTerminal('rebuild.sh');
  runTerminal('build-fts.sh');
  const searchReply = await request(2, 'tools/call', { name: 'databrain_search', arguments: { query: 'decision about access control' } });
  const searchText = searchReply.result.content[0].text;
  assert(searchText.includes('decision record.md'), `expected selected-source search result; got: ${searchText}`);
  const terminalParity = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), 'decision about access control', '5'], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: terminalMoc, NB_CANON_ROOTS_FILE: rootsFile, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(terminalParity.status, 0, `terminal route failed on the app fixture: ${terminalParity.stderr}`);
  const rankedPaths = text => text.split('\n').map(line => line.match(/^\s*\d+\s+-?[0-9]+(?:\.[0-9]+)?\s+(.+)$/)?.[1]).filter(Boolean);
  assert.deepEqual(rankedPaths(searchText), rankedPaths(terminalParity.stdout), 'MCP and terminal routes ranked the same engine fixture differently');
  const hit = searchText.match(/^\s*\d+\s+-?[0-9]+(?:\.[0-9]+)?\s+(.+)$/m)?.[1];
  assert(hit, 'search did not return a readable ranked path');
  const storedHit = (await fs.readFile(indexPath, 'utf8')).split('\n').find(line => line && !line.startsWith('#') && line.split('\t', 1)[0].replace(/^~/, os.homedir()) === hit)?.split('\t', 1)[0];
  assert(storedHit, 'search hit was missing from the generated index');
  const hitSidecar = path.join(dataHome, 'moc', 'extracted', `${createHash('sha1').update(storedHit).digest('hex').slice(0, 16)}.txt`);
  const sidecarSentinel = path.join(dataHome, 'sidecar-symlink-sentinel.txt');
  await fs.writeFile(sidecarSentinel, 'synthetic outside source text must not be exposed through a generated sidecar link');
  await fs.symlink(sidecarSentinel, hitSidecar);
  const linkedSidecarRead = await request(14, 'tools/call', { name: 'databrain_read', arguments: { path: hit, chars: 1200 } });
  const linkedSidecarText = linkedSidecarRead.result.content[0].text;
  assert(linkedSidecarText.includes('Could not safely open generated source text'), `generated sidecar symlink was followed: ${linkedSidecarText}`);
  assert(!linkedSidecarText.includes('must not be exposed'), 'generated sidecar symlink disclosed outside text');
  await fs.unlink(hitSidecar);
  await fs.rm(sidecarSentinel, { force: true });
  await fs.writeFile(hitSidecar, '<!-- newbrain-extract source: /outside/other-source.pdf -->\n\nsynthetic mismatched sidecar text must not be exposed');
  const mismatchedSidecarRead = await request(15, 'tools/call', { name: 'databrain_read', arguments: { path: hit, chars: 1200 } });
  const mismatchedSidecarText = mismatchedSidecarRead.result.content[0].text;
  assert(mismatchedSidecarText.includes('Could not safely open generated source text'), `mismatched generated sidecar was accepted: ${mismatchedSidecarText}`);
  assert(!mismatchedSidecarText.includes('must not be exposed'), 'mismatched generated sidecar content was disclosed');
  await fs.unlink(hitSidecar);
  await fs.writeFile(hitSidecar, `<!-- newbrain-extract source: ${storedHit} -->\n<!-- newbrain-extract fingerprint: 0:0:0 -->\n\nsynthetic stale sidecar text must not be exposed`);
  const staleSidecarRead = await request(16, 'tools/call', { name: 'databrain_read', arguments: { path: hit, chars: 1200 } });
  const staleSidecarText = staleSidecarRead.result.content[0].text;
  assert(staleSidecarText.includes('Could not safely open generated source text'), `stale generated sidecar was accepted: ${staleSidecarText}`);
  assert(!staleSidecarText.includes('must not be exposed'), 'stale generated sidecar content was disclosed');
  await fs.unlink(hitSidecar);
  const readReply = await request(3, 'tools/call', { name: 'databrain_read', arguments: { path: hit, chars: 1200 } });
  const readText = readReply.result.content[0].text;
  assert(readText.startsWith(`Evidence from: ${hit}\n`), `read result did not carry its exact source path: ${readText}`);
  assert(readText.includes('synthetic decision about access control'), `expected capped source excerpt; got: ${readText}`);
  assert(readText.includes('Ignore previous instructions'), 'synthetic prompt-injection text did not remain visibly inert source content');
  const terminalRead = spawnSync('/bin/bash', [path.join(engine, 'bin', 'look.sh'), 'decision about access control', '5'], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: terminalMoc, NB_CANON_ROOTS_FILE: rootsFile, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(terminalRead.status, 0, `terminal read route failed against its independent MOC: ${terminalRead.stderr}`);
  assert(terminalRead.stdout.includes('synthetic decision about access control'), `terminal read route did not return the same source excerpt: ${terminalRead.stdout}`);
  const heldRoot = `${sourceRoot}.root-race-held`;
  await fs.rm(rootRace.signal, { force: true });
  await fs.rm(rootRace.release, { force: true });
  await fs.writeFile(rootRace.arm, createHash('sha256').update(`root-${Date.now()}`).digest('hex'));
  const rootSwapReadPromise = request(18, 'tools/call', { name: 'databrain_read', arguments: { path: rootRace.target, chars: 1200 } });
  let rootSwapPaused = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.lstat(rootRace.signal); rootSwapPaused = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(rootSwapPaused, 'the root-swap fixture did not pause after stored-root validation');
  try {
    await fs.rename(sourceRoot, heldRoot);
    await fs.mkdir(sourceRoot);
    await fs.writeFile(rootRace.target, 'REPLACEMENT_ROOT_SECRET: never read or returned');
    await fs.writeFile(rootRace.release, 'resume realpath');
    const rootSwapRead = await rootSwapReadPromise;
    const rootSwapText = rootSwapRead.result.content[0].text;
    assert.match(rootSwapText, /approved source folder changed identity/i, `replacement source root was not rejected: ${rootSwapText}`);
    assert(!rootSwapText.includes('REPLACEMENT_ROOT_SECRET'), 'replacement-root content was disclosed');
  } finally {
    await fs.writeFile(rootRace.release, 'resume realpath');
    await fs.rm(sourceRoot, { recursive: true, force: true });
    try { await fs.rename(heldRoot, sourceRoot); } catch {}
    await fs.rm(rootRace.arm, { force: true });
    await fs.rm(rootRace.signal, { force: true });
    await fs.rm(rootRace.release, { force: true });
  }
  const heldSource = `${openRace.target}.race-held`;
  const outsideReadSentinel = `${dataHome}.outside-read-race-sentinel`;
  await fs.writeFile(outsideReadSentinel, 'outside source contents must not enter the Claude response');
  await fs.writeFile(openRace.arm, createHash('sha256').update(String(Date.now())).digest('hex'));
  const racingReadPromise = request(17, 'tools/call', { name: 'databrain_read', arguments: { path: openRace.target, chars: 1200 } });
  let openPaused = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.lstat(openRace.signal); openPaused = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(openPaused, 'the read-race fixture did not pause between path validation and open');
  try {
    await fs.rename(openRace.target, heldSource);
    await fs.symlink(outsideReadSentinel, openRace.target);
    await fs.writeFile(openRace.release, 'resume open');
    const racingRead = await racingReadPromise;
    const racingReadText = racingRead.result.content[0].text;
    assert(racingReadText.includes('Could not safely open this source') || racingReadText.includes('changed while it was being opened'), `raced source read did not fail closed: ${racingReadText}`);
    assert(!racingReadText.includes('outside source contents'), 'raced source read disclosed the outside sentinel');
  } finally {
    await fs.rm(openRace.target, { force: true });
    try { await fs.rename(heldSource, openRace.target); } catch {}
    await fs.rm(openRace.arm, { force: true });
    await fs.rm(openRace.signal, { force: true });
    await fs.rm(openRace.release, { force: true });
  await fs.rm(outsideReadSentinel, { force: true });
  }
  const unreadableSearch = await request(13, 'tools/call', { name: 'databrain_search', arguments: { query: 'neverindexunreadabletoken' } });
  assert(!unreadableSearch.result.content[0].text.includes('unreadable.txt'), 'unreadable source body was added to ranked search');
  const answerRoute = await request(8, 'tools/call', {
    name: 'databrain_abstain_check',
    arguments: { queries: ['decision about access control', 'synthetic decision account recovery'] },
  });
  const answerRouteText = answerRoute.result.content[0].text;
  assert(answerRouteText.includes('Reading route only; not an answer or absence verdict'), `abstain check presented its hint as a verdict: ${answerRouteText}`);
  assert(answerRouteText.includes('decision record.md') && answerRouteText.includes('databrain_read'), `abstain check did not route a known query to source reading: ${answerRouteText}`);
  const dryRoute = await request(9, 'tools/call', {
    name: 'databrain_abstain_check',
    arguments: { queries: ['quasar hippocampus zyzzyva', 'neutron fossilized kumquat'] },
  });
  assert(dryRoute.result.content[0].text.includes('DRY — none of these query variants returned approved-source candidates'), `absent query did not produce a dry reading route: ${dryRoute.result.content[0].text}`);
  assert(dryRoute.result.content[0].text.includes('Do not answer from DataBrain'), 'dry route did not direct the model to avoid an unsupported answer');
  assert(dryRoute.result.content[0].text.includes('not an answer or absence verdict'), 'dry search was presented as proof that the answer is absent');
  const terminalAbsent = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), 'quasar hippocampus zyzzyva', '5'], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: terminalMoc, NB_CANON_ROOTS_FILE: rootsFile, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  assert.equal(terminalAbsent.status, 0, `terminal absence probe failed against its independent MOC: ${terminalAbsent.stderr}`);
  assert(!rankedPaths(terminalAbsent.stdout).length, `terminal route unexpectedly found an absent-query hit: ${terminalAbsent.stdout}`);
  const duplicateVariants = await request(10, 'tools/call', {
    name: 'databrain_abstain_check',
    arguments: { queries: ['same query', ' SAME QUERY '] },
  });
  assert(duplicateVariants.result.content[0].text.includes('2–3 distinct'), 'duplicate variants were allowed to imply cross-query agreement');
  const outside = path.join(dataHome, 'unapproved synthetic.txt');
  await fs.writeFile(outside, 'This synthetic decoy must never be returned.');
  const denied = await request(4, 'tools/call', { name: 'databrain_read', arguments: { path: outside } });
  const deniedText = denied.result.content[0].text;
  assert(deniedText.includes('Search this source first'), `unapproved read was not rejected: ${deniedText}`);
  assert(!deniedText.includes('synthetic decoy'), 'unapproved file content leaked');

  const candidatesReply = await request(5, 'tools/call', { name: 'databrain_taxonomy_candidates', arguments: {} });
  const candidateText = candidatesReply.result.content[0].text;
  const candidateRow = candidateText.split('\n').find(line => line.includes(path.basename(sourceRoot)));
  const folderId = candidateRow?.match(/^(folder-[a-f0-9]+)\t/)?.[1];
  assert(folderId, `taxonomy candidates omitted the selected root group: ${candidateText}`);
  assert(candidateText.includes('decision record'), `taxonomy candidates omitted indexed file evidence: ${candidateText}`);
  const docxIndexRow = initialIndex.split('\n').find(line => line.startsWith(`${path.join(retainedRoot, 'analysis.docx')}\t`));
  assert(docxIndexRow?.split('\t')[3].split(',').includes('revocation'), `index did not retain the extracted DOCX keyword on its source file row: ${docxIndexRow}`);
  assert(candidateText.includes('analysis'), `taxonomy candidates omitted the DOCX title evidence: ${candidateText}`);
  assert(!candidateText.includes('synthetic decision about access control'), 'taxonomy candidate pass exposed a document body');
  const apply = await request(6, 'tools/call', {
    name: 'databrain_apply_taxonomy',
    arguments: { assignments: [{ folder_id: folderId, categories: ['decisions'] }] },
  });
  assert(apply.result.content[0].text.includes('application started'), `taxonomy was not queued: ${apply.result.content[0].text}`);
  let taxonomyStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(7 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    taxonomyStatus = reply.result.content[0].text;
    if (taxonomyStatus.includes('Stage: relationships pending')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(taxonomyStatus.includes('Stage: relationships pending'), `taxonomy job did not finish: ${taxonomyStatus}`);
  const index = await fs.readFile(indexPath, 'utf8');
  assert(index.split('\n').some(line => line.includes('decision record.md') && line.split('\t')[2] === 'decisions'), 'confirmed category was not recorded in the shared index');
  const slowRelationshipFixture = path.join(sourceRoot, 'relationship-cancel-fixture.bin');
  const slowFixtureHandle = await fs.open(slowRelationshipFixture, 'w');
  await slowFixtureHandle.truncate(96 * 1024 * 1024);
  await slowFixtureHandle.close();
  await fs.appendFile(indexPath, `${slowRelationshipFixture}\tRelationship cancellation fixture\t-\t-\n`);
  const cancelRelationships = await request(17, 'tools/call', { name: 'databrain_build_relationships', arguments: {} });
  const cancelJobId = cancelRelationships.result.content[0].text.match(/job ([0-9a-f-]{36})/)?.[1];
  assert(cancelJobId, `large relationship fixture did not start a cancellable job: ${cancelRelationships.result.content[0].text}`);
  const cancelReply = await request(18, 'tools/call', { name: 'databrain_cancel_job', arguments: { job_id: cancelJobId } });
  assert(cancelReply.result.content[0].text.includes('Cancellation requested'), `relationship cancellation was not accepted: ${cancelReply.result.content[0].text}`);
  let cancelledRelationshipStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1000 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    cancelledRelationshipStatus = reply.result.content[0].text;
    if (cancelledRelationshipStatus.includes(`relationship report: cancelled`)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(cancelledRelationshipStatus.includes('relationship report: cancelled'), `relationship job did not stop after cancellation: ${cancelledRelationshipStatus}`);
  await assert.rejects(fs.lstat(path.join(dataHome, 'moc', 'relationships.tsv')), { code: 'ENOENT' }, 'cancelled relationship job published a partial report');
  await fs.rm(slowRelationshipFixture, { force: true });
  await fs.writeFile(indexPath, index);
  const relationshipHeldSource = `${openRace.target}.relationship-race-held`;
  const outsideRelationshipSentinel = `${dataHome}.outside-relationship-race-sentinel`;
  await fs.writeFile(outsideRelationshipSentinel, 'relationship scan must not read this outside sentinel');
  await Promise.all([fs.rm(openRace.signal, { force: true }), fs.rm(openRace.release, { force: true })]);
  await fs.writeFile(openRace.arm, createHash('sha256').update(`relationship-${Date.now()}`).digest('hex'));
  const racingRelationshipStart = await request(23, 'tools/call', { name: 'databrain_build_relationships', arguments: {} });
  assert(racingRelationshipStart.result.content[0].text.includes('Relationship report started'), `relationship race fixture did not start: ${racingRelationshipStart.result.content[0].text}`);
  let relationshipOpenPaused = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.lstat(openRace.signal); relationshipOpenPaused = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(relationshipOpenPaused, 'relationship race fixture did not pause before opening its source');
  try {
    await fs.rename(openRace.target, relationshipHeldSource);
    await fs.symlink(outsideRelationshipSentinel, openRace.target);
    await fs.writeFile(openRace.release, 'resume relationship open');
    let failedRelationship = '';
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const reply = await request(2500 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
      failedRelationship = reply.result.content[0].text;
      if (failedRelationship.includes('relationship report: failed')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert(failedRelationship.includes('relationship report: failed'), `raced relationship read did not fail closed: ${failedRelationship}`);
    assert(!failedRelationship.includes('outside sentinel'), 'relationship status disclosed the outside sentinel');
    await assert.rejects(fs.lstat(path.join(dataHome, 'moc', 'relationships.tsv')), { code: 'ENOENT' }, 'raced relationship job published partial metadata');
  } finally {
    await fs.writeFile(openRace.release, 'resume relationship open');
    await fs.rm(openRace.target, { force: true });
    try { await fs.rename(relationshipHeldSource, openRace.target); } catch {}
    await fs.rm(openRace.arm, { force: true });
    await fs.rm(openRace.signal, { force: true });
    await fs.rm(openRace.release, { force: true });
    await fs.rm(outsideRelationshipSentinel, { force: true });
  }
  const relationships = await request(11, 'tools/call', { name: 'databrain_build_relationships', arguments: {} });
  assert(relationships.result.content[0].text.includes('Relationship report started'), `relationship report did not start: ${relationships.result.content[0].text}`);
  let relationshipStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(300 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    relationshipStatus = reply.result.content[0].text;
    if (relationshipStatus.includes('Stage: verification pending')) break;
    const relationshipJobs = relationshipStatus.split('\n').filter(line => line.startsWith('relationship report:'));
    if (relationshipJobs.at(-1)?.includes('relationship report: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(relationshipStatus.includes('Stage: verification pending'), `relationship report did not finish: ${relationshipStatus}`);
  assert(relationshipStatus.includes('relationship report: complete'), `relationship job did not report success: ${relationshipStatus}`);
  const appRelationshipReport = await fs.readFile(path.join(dataHome, 'moc', 'relationships.tsv'), 'utf8');
  const terminalRelationships = spawnSync('/bin/bash', [path.join(engine, 'bin/relationships.sh')], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: path.join(dataHome, 'moc'), NB_CANON_ROOTS_FILE: rootsFile },
  });
  assert.equal(terminalRelationships.status, 0, `Terminal relationship operation failed: ${terminalRelationships.stderr}`);
  const terminalRelationshipReport = await fs.readFile(path.join(dataHome, 'moc', 'relationships.tsv'), 'utf8');
  assert.equal(terminalRelationshipReport, appRelationshipReport, 'Terminal and Claude Desktop app relationship results diverged on the same selected-root fixture');
  const relationshipRows = appRelationshipReport.trim().split('\n').slice(1).map(line => line.split('\t').map(value => decodeURIComponent(value.replace(/\+/g, ' '))));
  const decisionRelationship = relationshipRows.find(row => row[0].endsWith('/decision record.md'));
  assert(decisionRelationship?.[4].includes('/Project files/project.md'), `explicit Markdown link was not preserved: ${JSON.stringify(decisionRelationship)}`);
  const duplicateRows = relationshipRows.filter(row => row[0].endsWith('/project.md') || row[0].endsWith('/access.txt'));
  assert(duplicateRows.length === 2 && duplicateRows.every(row => row[5] !== '-'), `exact duplicate files were not grouped: ${JSON.stringify(duplicateRows)}`);
  const conflictRow = relationshipRows.find(row => row[0] === conflictPath);
  assert(conflictRow?.[6] === 'review', `same-title conflict was not flagged: ${JSON.stringify(conflictRow)}`);
  const missingRow = relationshipRows.find(row => row[0] === missingPdf);
  assert(missingRow?.[7] === 'missing', `missing indexed file was not preserved as an exception: ${JSON.stringify(missingRow)}`);
  const unsafeLinkRow = relationshipRows.find(row => row[0] === symlinkPath);
  assert(unsafeLinkRow?.[7] === 'symbolic_link' && unsafeLinkRow[5] === '-', `source symlink was not excluded from hashing: ${JSON.stringify(unsafeLinkRow)}`);
  const unreadableRelationshipRow = relationshipRows.find(row => row[0].endsWith('/unreadable.txt'));
  assert(unreadableRelationshipRow?.[7] === 'unreadable', `unreadable indexed file was not preserved as an exception: ${JSON.stringify(unreadableRelationshipRow)}`);

  const protectedOriginal = path.join(sourceRoot, 'decision record.md');
  const originalDigest = createHash('sha256').update(await fs.readFile(protectedOriginal)).digest('hex');
  const today = new Date().toISOString().slice(0, 10);
  const collisionPath = path.join(sourceRoot, `${today} Capture RAG fixture.md`);
  await fs.writeFile(collisionPath, 'Existing note must never be replaced.\n');
  await fs.writeFile(selectionFile, `${sourceRoot}\n`, { mode: 0o600 });
  let nextWriteId = 40;
  async function saveAndVerify(tool, args, query, requiredMetadata) {
    const id = nextWriteId++ * 10;
    const started = await request(id, 'tools/call', { name: tool, arguments: args });
    const jobId = started.result.content[0].text.match(/Save job: ([0-9a-f-]{36})/)?.[1];
    assert(jobId, `${tool} did not return a write job: ${started.result.content[0].text}`);
    let finalStatus = '';
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const reply = await request(id + 1000 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
      finalStatus = reply.result.content[0].text;
      const jobLine = finalStatus.split('\n').find(line => line.includes('note write: complete') && line.includes(args.title));
      if (jobLine) break;
      if (finalStatus.includes('note write: failed')) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(finalStatus.split('\n').some(line => line.includes('note write: complete') && line.includes(args.title)), `${tool} did not complete: ${finalStatus}`);
    const search = await request(id + 2000, 'tools/call', { name: 'databrain_search', arguments: { query } });
    const hit = search.result.content[0].text.split('\n').find(line => line.includes(args.title));
    assert(hit, `${tool} note was not searchable by its selected keyword: ${search.result.content[0].text}`);
    const storedPath = hit.match(/^\s*\d+\s+-?[0-9]+(?:\.[0-9]+)?\s+(.+)$/)?.[1];
    const storedRow = (await fs.readFile(indexPath, 'utf8')).split('\n').find(line => line && !line.startsWith('#') && line.split('\t', 1)[0].replace(/^~/, os.homedir()) === storedPath);
    assert(storedRow?.split('\t')[3].includes(args.keywords[0]), `${tool} keywords were not recorded in the shared index: ${storedRow}`);
    const read = await request(id + 2001, 'tools/call', { name: 'databrain_read', arguments: { path: storedPath, chars: 1200 } });
    assert(read.result.content[0].text.includes(args.body) && read.result.content[0].text.includes(requiredMetadata), `${tool} note content or type metadata was not preserved: ${read.result.content[0].text}`);
    assert(storedPath.startsWith(`${sourceRoot}/`), `${tool} note escaped the chosen approved folder: ${storedPath}`);
    return storedPath;
  }

  const capturePath = await saveAndVerify('databrain_capture', {
    title: 'Capture RAG fixture', body: 'Violet telescope notes capture selected for local retrieval.', keywords: ['violet', 'telescope'],
  }, 'violet', 'status: unrouted');
  const duplicateKeywords = await request(509, 'tools/call', { name: 'databrain_capture', arguments: {
    title: 'Duplicate keyword fixture', body: 'This should be rejected before opening a folder chooser.', keywords: ['amber', 'amber'],
  } });
  assert(duplicateKeywords.result.content?.[0]?.text?.includes('distinct lowercase search keywords'), `duplicate keywords passed validation: ${JSON.stringify(duplicateKeywords.result)}`);
  assert(capturePath.endsWith(`${today} Capture RAG fixture (1).md`), `capture overwrote a pre-existing note instead of choosing a new filename: ${capturePath}`);
  await saveAndVerify('databrain_file_note', {
    title: 'Filed RAG fixture', body: 'Amber microscope report filed into research.', themes: ['research'], keywords: ['amber', 'microscope'],
  }, 'amber', 'theme: [research]');
  await saveAndVerify('databrain_save_synthesis', {
    title: 'Synthesis RAG fixture', body: 'Cobalt prism synthesis approved for retention.', themes: ['synthesis'], keywords: ['cobalt', 'prism'],
  }, 'cobalt', 'type: synthesis');
  assert.equal(await fs.readFile(collisionPath, 'utf8'), 'Existing note must never be replaced.\n', 'note creation replaced an existing file');
  assert.equal(createHash('sha256').update(await fs.readFile(protectedOriginal)).digest('hex'), originalDigest, 'note creation changed an existing canonical source');
  const heldWriteRoot = `${sourceRoot}.note-race-held`;
  await Promise.all([fs.rm(noteRace.signal, { force: true }), fs.rm(noteRace.release, { force: true })]);
  await fs.writeFile(noteRace.arm, createHash('sha256').update(`note-${Date.now()}`).digest('hex'));
  const racingWrite = await request(438, 'tools/call', { name: 'databrain_capture', arguments: {
    title: 'Raced capture fixture', body: 'PRIVATE_NOTE_BODY must stay out of a replacement folder.', keywords: ['raced', 'capture'],
  } });
  assert(racingWrite.result.content[0].text.includes('Save job:'), `write race fixture did not start: ${racingWrite.result.content[0].text}`);
  let noteOpenPaused = false;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { await fs.lstat(noteRace.signal); noteOpenPaused = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert(noteOpenPaused, 'write race fixture did not pause before opening its new note');
  try {
    await fs.rename(sourceRoot, heldWriteRoot);
    await fs.mkdir(sourceRoot);
    await fs.writeFile(noteRace.release, 'resume note open');
    let racedWriteStatus = '';
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const reply = await request(4400 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
      racedWriteStatus = reply.result.content[0].text;
      if (racedWriteStatus.includes('note write: failed')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(racedWriteStatus, /approved source folder changed identity/i, `replacement root was not rejected before writing note content: ${racedWriteStatus}`);
    await assert.rejects(fs.lstat(noteRace.target), { code: 'ENOENT' }, 'replacement folder received a new file, even an empty one');
    assert(!(await fs.readFile(indexPath, 'utf8')).includes('Raced capture fixture'), 'raced note entered the active index');
  } finally {
    await fs.writeFile(noteRace.release, 'resume note open');
    await fs.rm(sourceRoot, { recursive: true, force: true });
    try { await fs.rename(heldWriteRoot, sourceRoot); } catch {}
    await Promise.all([noteRace.arm, noteRace.signal, noteRace.release].map(file => fs.rm(file, { force: true })));
  }
  await fs.writeFile(selectionFile, `${await fs.realpath(dataHome)}\n`, { mode: 0o600 });
  const deniedWrite = await request(444, 'tools/call', { name: 'databrain_capture', arguments: { title: 'Denied note', body: 'This must not be written.', keywords: ['denied', 'write'] } });
  assert(deniedWrite.result.content[0].text.includes('Save job:'), `write-boundary test did not start: ${deniedWrite.result.content[0].text}`);
  let deniedStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(5000 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    deniedStatus = reply.result.content[0].text;
    if (deniedStatus.includes('note write: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert(deniedStatus.includes('Choose a regular folder inside one of the source folders you already approved'), `unapproved write destination was not rejected: ${deniedStatus}`);
  assert(!(await fs.readdir(sourceRoot)).some(name => name.includes('Denied note')), 'unapproved destination selection created a note');

  const refreshAfterRelationships = await request(12, 'tools/call', { name: 'databrain_refresh', arguments: {} });
  assert(refreshAfterRelationships.result.content[0].text.includes('Indexing started'), `refresh was unavailable after relationship setup: ${refreshAfterRelationships.result.content[0].text}`);
  let refreshedStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(500 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    refreshedStatus = reply.result.content[0].text;
    if (refreshedStatus.includes('Stage: taxonomy pending')) break;
    if (refreshedStatus.includes('refresh: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(refreshedStatus.includes('Stage: taxonomy pending'), `refresh after relationships did not finish: ${refreshedStatus}`);
  await assert.rejects(fs.lstat(path.join(dataHome, 'moc', 'relationships.tsv')), { code: 'ENOENT' }, 'refresh left an out-of-date relationship report active');

  const revokedRow = index.split('\n').find(line => line.includes('decision record.md'));
  assert(revokedRow, 'expected a generated index row to remove');
  const revokedStoredPath = revokedRow.split('\t', 1)[0];
  const revokedSidecar = path.join(dataHome, 'moc', 'extracted', `${createHash('sha1').update(revokedStoredPath).digest('hex').slice(0, 16)}.txt`);
  await fs.mkdir(path.dirname(revokedSidecar), { recursive: true });
  await fs.writeFile(revokedSidecar, 'synthetic derived text for revoked source');
  const broadRoot = await fs.realpath(path.dirname(dataHome));
  await fs.writeFile(selectionFile, `${broadRoot}\n`, { mode: 0o600 });
  const tooBroad = await request(70, 'tools/call', { name: 'databrain_select_sources', arguments: {} });
  assert(tooBroad.result.content[0].text.includes('folder chooser is open'), `broad-root selection was not queued for validation: ${tooBroad.result.content[0].text}`);
  let broadStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(71 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    broadStatus = reply.result.content[0].text;
    if (broadStatus.includes('source folder selection: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(broadStatus.includes('cannot contain DataBrain'), `a root containing the DataBrain destination was accepted: ${broadStatus}`);
  assert((await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).trim().split('\n').length === roots.length, 'rejected broad-root selection changed the source grant');
  const newlineRoot = path.join(path.dirname(retainedRoot), 'invalid\nsource root');
  const grantBeforeDelimiterTest = await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8');
  await fs.mkdir(newlineRoot, { recursive: true });
  await fs.writeFile(selectionFile, `${newlineRoot}\0`, { mode: 0o600 });
  const newlineSelect = await request(72, 'tools/call', { name: 'databrain_select_sources', arguments: {} });
  assert(newlineSelect.result.content[0].text.includes('folder chooser is open'), `line-break source selection was not queued: ${newlineSelect.result.content[0].text}`);
  let newlineStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(172 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    newlineStatus = reply.result.content[0].text;
    if (newlineStatus.includes('contains a tab or line break')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(newlineStatus.includes('contains a tab or line break'), `unsafe line-break source root was not rejected: ${newlineStatus}`);
  assert.equal(await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8'), grantBeforeDelimiterTest, 'rejected line-break folder changed the approved grant');
  await fs.rm(newlineRoot, { recursive: true, force: true });
  await fs.writeFile(selectionFile, `${retainedRoot}\n`, { mode: 0o600 });
  const select = await request(40, 'tools/call', { name: 'databrain_select_sources', arguments: {} });
  assert(select.result.content[0].text.includes('folder chooser is open'), `source selection was not queued: ${select.result.content[0].text}`);
  let selectStatus = '';
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const reply = await request(41 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    selectStatus = reply.result.content[0].text;
    if (selectStatus.includes('source folder selection: complete')) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(selectStatus.includes('source folder selection: complete'), `source selection cleanup did not finish: ${selectStatus}`);
  const prunedIndex = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  await assert.rejects(fs.lstat(path.join(dataHome, 'moc', 'relationships.tsv')), { code: 'ENOENT' }, 'source-grant change left stale relationship metadata behind');
  assert(!prunedIndex.includes('decision record.md'), 'revoked-source row remained in the generated index');
  assert(prunedIndex.split('\n').some(line => line && !line.startsWith('#') && line.includes(retainedRoot)), 'retained-source row was removed');
  await assert.rejects(fs.lstat(revokedSidecar), { code: 'ENOENT' }, 'revoked-source extract sidecar remained in DataBrain');
  const revokedSearch = await request(80, 'tools/call', { name: 'databrain_search', arguments: { query: 'decision about access control' } });
  assert(!revokedSearch.result.content[0].text.includes('decision record.md'), 'revoked-source record remained searchable');
  const revokedRead = await request(81, 'tools/call', { name: 'databrain_read', arguments: { path: hit, chars: 1200 } });
  assert(revokedRead.result.content[0].text.includes('currently present in the active DataBrain index'), `revoked-source hit was not rejected by active-index check: ${revokedRead.result.content[0].text}`);
  const additionalRoot = path.join(await fs.realpath(path.dirname(dataHome)), 'Additional selected source');
  await fs.mkdir(additionalRoot, { recursive: true });
  await fs.writeFile(path.join(additionalRoot, 'additional.md'), '# Additional source\nZinnia architecture revocation audit fixture.\n');
  await fs.writeFile(selectionFile, `${additionalRoot}\n`, { mode: 0o600 });
  const addSource = await request(83, 'tools/call', { name: 'databrain_add_sources', arguments: {} });
  assert(addSource.result.content[0].text.includes('folder chooser is open'), `additional source selection was not queued: ${addSource.result.content[0].text}`);
  let addStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(600 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    addStatus = reply.result.content[0].text;
    const currentGrant = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).split('\n');
    const currentState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
    if (currentGrant.includes(additionalRoot) && currentState.roots.includes(additionalRoot) && addStatus.includes('Added the selected folder(s)')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const addedGrant = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).split('\n');
  const addedState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
  assert(addedGrant.includes(additionalRoot) && addedState.roots.includes(additionalRoot) && addStatus.includes('Added the selected folder(s)'), `adding source failed: ${addStatus}`);
  const combinedRoots = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).trim().split('\n');
  assert(combinedRoots.includes(retainedRoot) && combinedRoots.includes(additionalRoot), `adding a source replaced the existing approved source: ${JSON.stringify({ retainedRoot, additionalRoot, combinedRoots })}`);
  const addRun = await request(84, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(addRun.result.content[0].text.includes('Indexing started'), `indexing the additional source did not start: ${addRun.result.content[0].text}`);
  let addedStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(700 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    addedStatus = reply.result.content[0].text;
    if (addedStatus.includes('Stage: taxonomy pending')) break;
    if (addedStatus.includes('initial indexing: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(addedStatus.includes('Stage: taxonomy pending'), `added source did not index: ${addedStatus}`);
  const addedSearch = await request(85, 'tools/call', { name: 'databrain_search', arguments: { query: 'zinnia architecture' } });
  assert(addedSearch.result.content[0].text.includes('additional.md'), `newly approved source was not searchable: ${addedSearch.result.content[0].text}`);
  const emptyRoot = path.join(await fs.realpath(path.dirname(dataHome)), 'Empty selected source');
  await fs.mkdir(emptyRoot, { recursive: true });
  await fs.writeFile(selectionFile, `${emptyRoot}\n`, { mode: 0o600 });
  const addEmpty = await request(86, 'tools/call', { name: 'databrain_add_sources', arguments: {} });
  assert(addEmpty.result.content[0].text.includes('folder chooser is open'), `empty source selection was not queued: ${addEmpty.result.content[0].text}`);
  let emptyAddStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(800 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    emptyAddStatus = reply.result.content[0].text;
    const currentGrant = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).split('\n');
    const currentState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
    if (currentGrant.includes(emptyRoot) && currentState.roots.includes(emptyRoot) && emptyAddStatus.includes('Added the selected folder(s)')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  const emptyGrant = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).split('\n');
  const emptyState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
  assert(emptyGrant.includes(emptyRoot) && emptyState.roots.includes(emptyRoot) && emptyAddStatus.includes('Added the selected folder(s)'), `empty source folder was not added: ${emptyAddStatus}`);
  assert.deepEqual(await fs.readdir(emptyRoot), [], 'the selected empty source fixture unexpectedly contains files');
  const indexEmpty = await request(87, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(indexEmpty.result.content[0].text.includes('Indexing started'), `setup did not resume with an empty selected folder: ${indexEmpty.result.content[0].text}`);
  let emptySetupStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(900 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    emptySetupStatus = reply.result.content[0].text;
    if (emptySetupStatus.includes('Stage: taxonomy pending') && emptySetupStatus.includes('Selected source folders: 3.')) break;
    if (emptySetupStatus.includes('initial indexing: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(emptySetupStatus.includes('Stage: taxonomy pending') && emptySetupStatus.includes('Selected source folders: 3.'), `empty folder disrupted setup: ${emptySetupStatus}`);
  assert(emptySetupStatus.includes('File inventory: 6 indexed, 0 eligible missing from index, 1 unsupported; unreadable 1'), `empty folder changed supported/unreadable inventory: ${emptySetupStatus}`);
  const activeIndex = indexPath;
  const savedIndex = `${activeIndex}.safe-test-copy`;
  const sentinel = `${dataHome}.outside-index-sentinel`;
  const sentinelBefore = 'must remain unchanged when a generated index path is replaced';
  await fs.writeFile(sentinel, sentinelBefore);
  await fs.rename(activeIndex, savedIndex);
  await fs.symlink(sentinel, activeIndex);
  const symlinkStatus = await request(82, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
  assert(symlinkStatus.result.content[0].text.includes('DataBrain setup state is unreadable'), `generated index symlink was not rejected: ${symlinkStatus.result.content[0].text}`);
  assert.equal(await fs.readFile(sentinel, 'utf8'), sentinelBefore, 'generated index symlink changed a file outside the DataBrain folder');
  await fs.unlink(activeIndex);
  await fs.rename(savedIndex, activeIndex);
  await fs.rm(sentinel, { force: true });
  await fs.writeFile(selectionFile, `${emptyRoot}\n`, { mode: 0o600 });
  const selectOnlyEmpty = await request(21, 'tools/call', { name: 'databrain_select_sources', arguments: {} });
  assert(selectOnlyEmpty.result.content[0].text.includes('folder chooser is open'), `empty-only source selection was not queued: ${selectOnlyEmpty.result.content[0].text}`);
  let emptyOnlySelectionStatus = '';
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const reply = await request(1400 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    emptyOnlySelectionStatus = reply.result.content[0].text;
    const currentGrant = (await fs.readFile(path.join(dataHome, '.source-roots'), 'utf8')).split('\n').filter(Boolean);
    const currentState = JSON.parse(await fs.readFile(path.join(dataHome, '.databrain', 'desktop-state.json'), 'utf8'));
    if (currentGrant.length === 1 && currentGrant[0] === emptyRoot && currentState.roots.length === 1 && currentState.roots[0] === emptyRoot && emptyOnlySelectionStatus.includes('Selected source folders: 1.')) break;
    const selectionJobs = emptyOnlySelectionStatus.split('\n').filter(line => line.startsWith('source folder selection:'));
    if (selectionJobs.at(-1)?.includes('source folder selection: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(emptyOnlySelectionStatus.includes('Selected source folders: 1.'), `empty-only source selection was not recorded: ${emptyOnlySelectionStatus}`);
  const emptyOnlyRun = await request(22, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(emptyOnlyRun.result.content[0].text.includes('Indexing started'), `empty-only setup did not start: ${emptyOnlyRun.result.content[0].text}`);
  let emptyOnlyStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1500 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    emptyOnlyStatus = reply.result.content[0].text;
    if (emptyOnlyStatus.includes('Stage: taxonomy pending') && emptyOnlyStatus.includes('Indexed rows: 0.')) break;
    if (emptyOnlyStatus.includes('initial indexing: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(emptyOnlyStatus.includes('Stage: taxonomy pending') && emptyOnlyStatus.includes('Indexed rows: 0.'), `empty-only setup did not report its completed inventory: ${emptyOnlyStatus}`);
  assert(emptyOnlyStatus.includes('No eligible files were found') && emptyOnlyStatus.includes('databrain_add_sources'), `empty-only setup did not give a clear recovery action: ${emptyOnlyStatus}`);

  // Exercise the cloud-placeholder branch with one disposable file. The shims report
  // dataless metadata only for this exact fixture path; every other ls/stat call delegates
  // to the host binaries. This is deterministic branch evidence, not physical iCloud proof.
  await fs.mkdir(cloudFixtureRoot, { recursive: true });
  await fs.writeFile(cloudFixture, 'CLOUD_PLACEHOLDER_BODY_SENTINEL must never enter RAG content.\n');
  await fs.mkdir(runtimeBin, { recursive: true });
  await assert.rejects(fs.lstat(cloudLsShim), { code: 'ENOENT' }, 'cloud fixture would overwrite an existing ls runtime shim');
  await assert.rejects(fs.lstat(cloudStatShim), { code: 'ENOENT' }, 'cloud fixture would overwrite an existing stat runtime shim');
  await fs.writeFile(cloudLsShim, [
    '#!/bin/bash',
    'if [ "$#" -eq 2 ] && [ "$1" = "-lO" ] && [ "$2" = "$DATABRAIN_CLOUD_PLACEHOLDER" ]; then',
    '  /bin/ls -l "$2"',
    '  printf "flags: dataless\\n"',
    'else',
    '  exec /bin/ls "$@"',
    'fi',
    '',
  ].join('\n'), { mode: 0o755 });
  await fs.writeFile(cloudStatShim, [
    '#!/bin/bash',
    'if [ "$#" -eq 3 ] && [ "$1" = "-f" ] && [ "$2" = "%Sf" ] && [ "$3" = "$DATABRAIN_CLOUD_PLACEHOLDER" ]; then',
    '  printf "dataless\\n"',
    'else',
    '  exec /usr/bin/stat "$@"',
    'fi',
    '',
  ].join('\n'), { mode: 0o755 });
  cloudShimsInstalled = true;
  // Restart the disposable server so child engine processes inherit the path-scoped shim target.
  process.env.DATABRAIN_CLOUD_PLACEHOLDER = cloudFixture;
  const cloudServer = server;
  const cloudServerClosed = new Promise(resolve => cloudServer.once('close', resolve));
  cloudServer.kill('SIGTERM');
  await cloudServerClosed;
  server = startServer();
  const cloudInit = await request(29, 'initialize', { protocolVersion: '2025-03-26' });
  assert.equal(cloudInit.result.serverInfo.name, 'databrain');
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await fs.writeFile(selectionFile, `${cloudFixtureRoot}\n`, { mode: 0o600 });
  const selectCloudRoot = await request(23, 'tools/call', { name: 'databrain_select_sources', arguments: {} });
  assert(selectCloudRoot.result.content[0].text.includes('folder chooser is open'), `cloud fixture source selection did not start: ${selectCloudRoot.result.content[0].text}`);
  let cloudSelectionStatus = '';
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const reply = await request(1800 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    cloudSelectionStatus = reply.result.content[0].text;
    if (cloudSelectionStatus.includes('Selected source folders: 1.') && cloudSelectionStatus.includes('source folder selection: complete')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(cloudSelectionStatus.includes('Selected source folders: 1.') && cloudSelectionStatus.includes('source folder selection: complete'), `cloud fixture source selection did not finish: ${cloudSelectionStatus}`);
  const cloudSetup = await request(24, 'tools/call', { name: 'databrain_setup_run', arguments: {} });
  assert(cloudSetup.result.content[0].text.includes('Indexing started'), `cloud fixture indexing did not start: ${cloudSetup.result.content[0].text}`);
  let cloudSetupStatus = '';
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const reply = await request(1900 + attempt, 'tools/call', { name: 'databrain_setup_status', arguments: {} });
    cloudSetupStatus = reply.result.content[0].text;
    if (cloudSetupStatus.includes('Stage: taxonomy pending')) break;
    if (cloudSetupStatus.includes('initial indexing: failed')) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert(cloudSetupStatus.includes('Stage: taxonomy pending'), `cloud fixture indexing did not finish: ${cloudSetupStatus}`);
  assert.match(cloudSetupStatus, /File inventory: 1 indexed, 0 eligible missing from index, 0 unsupported; unreadable 0, cloud placeholders 1, empty 0, traversal errors 0\./, `setup status did not report the cloud placeholder: ${cloudSetupStatus}`);
  const cloudHealth = await request(25, 'tools/call', { name: 'databrain_health', arguments: {} });
  assert.match(cloudHealth.result.content[0].text, /File inventory: 1 indexed; 0 eligible missing; 0 unsupported; unreadable 0; placeholders 1; empty 0; traversal errors 0\./, `health did not report the cloud placeholder: ${cloudHealth.result.content[0].text}`);
  const cloudIndex = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  const cloudIndexRow = cloudIndex.split('\n').find(line => line.startsWith(`${cloudFixture}\t`));
  assert(cloudIndexRow, 'cloud placeholder path was not inventoried in the index');
  assert(!cloudIndex.includes('CLOUD_PLACEHOLDER_BODY_SENTINEL'), 'cloud placeholder body entered the generated index');
  assert(cloudIndexRow.split('\t')[3].split(',').includes('sentinel'), `cloud placeholder content was not used to derive search keywords: ${cloudIndexRow}`);
  const cloudExtract = path.join(dataHome, 'moc', 'extracted', `${createHash('sha1').update(cloudFixture).digest('hex').slice(0, 16)}.txt`);
  const cloudExtractText = await fs.readFile(cloudExtract, 'utf8');
  assert(cloudExtractText.includes('CLOUD_PLACEHOLDER_BODY_SENTINEL'), 'cloud placeholder body was not preserved in its derived text sidecar');
  const cloudBodySearch = await request(26, 'tools/call', { name: 'databrain_search', arguments: { query: 'sentinel' } });
  assert(cloudBodySearch.result.content[0].text.includes(cloudFixture), `cloud placeholder body was not searchable after extraction: ${cloudBodySearch.result.content[0].text}`);
  const cloudTitleSearch = await request(27, 'tools/call', { name: 'databrain_search', arguments: { query: 'cloud placeholder fixture' } });
  assert(cloudTitleSearch.result.content[0].text.includes(cloudFixture), `cloud placeholder title/path was not retained as an inventory lead: ${cloudTitleSearch.result.content[0].text}`);
  const cloudRead = await request(28, 'tools/call', { name: 'databrain_read', arguments: { path: cloudFixture, chars: 1200 } });
  assert(cloudRead.result.content[0].text.includes('CLOUD_PLACEHOLDER_BODY_SENTINEL'), `selected cloud placeholder body was not safely readable: ${cloudRead.result.content[0].text}`);
  delete process.env.DATABRAIN_CLOUD_PLACEHOLDER;
  await fs.rm(cloudLsShim, { force: true });
  await fs.rm(cloudStatShim, { force: true });
  cloudShimsInstalled = false;
  await fs.rm(cloudFixtureRoot, { recursive: true, force: true });
  assert(cloudSetupStatus.includes('cloud placeholders 1'), 'cloud placeholder fixture did not reach setup status');
  console.log('PASS: MCP selected-root search/read, root-swap read/write rejection, empty-corpus recovery, extraction-sidecar confinement, interrupted-index cancellation/restart/resume, relationship cancellation, and capture/note/synthesis write-back use the shared engine with scoped new-file creation and indexed keywords.');
} catch (error) {
  throw new Error(`${error.message}${stderr ? `\nMCP stderr: ${stderr}` : ''}`);
} finally {
  server.kill('SIGTERM');
  await new Promise(resolve => server.once('close', resolve));
  await fs.rm(selectionFile, { force: true });
  await Promise.all([openRace.arm, openRace.signal, openRace.release].map(file => fs.rm(file, { force: true })));
  await Promise.all([rootRace.arm, rootRace.signal, rootRace.release, noteRace.arm, noteRace.signal, noteRace.release].map(file => fs.rm(file, { force: true })));
  delete process.env.DATABRAIN_CLOUD_PLACEHOLDER;
  if (cloudShimsInstalled) {
    await fs.rm(cloudLsShim, { force: true });
    await fs.rm(cloudStatShim, { force: true });
  }
  await fs.rm(cloudFixtureRoot, { recursive: true, force: true });
}
