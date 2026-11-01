// Storage failures in the local privacy ledger must stop extraction before derived data is published.
// Every source and canary below is synthetic; no real notes or credentials are read.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [engine] = process.argv.slice(2);
assert(engine, 'usage: test_mcp_privacy_failure_closed.mjs PACKAGED_ENGINE_DIRECTORY');
assert.notEqual(process.getuid?.(), 0, 'permission-failure fixtures require a normal, non-root user');
const privacy = path.join(engine, 'bin', 'privacy.pl');
const extract = path.join(engine, 'bin', 'extract.sh');
const canary = 'syntheticfarawayexcerptcanary';
const benignCanary = 'benignprivacycontrolmarker';
const privateText = `SYNTHETIC TEST ONLY; fake password: Example-Only-not-a-credential-9\n${'harmless synthetic filler text '.repeat(1800)}\n${canary}`;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-privacy-fail-')));
const home = path.join(temp, 'home');
const perlFaults = path.join(temp, 'perl-faults');
await fs.mkdir(home, { recursive: true });
await fs.mkdir(perlFaults, { recursive: true });
await fs.writeFile(path.join(perlFaults, 'FailClose.pm'), `package FailClose;
use strict;
our $calls = 0;
BEGIN {
  *CORE::GLOBAL::close = sub {
    $calls++;
    return 0 if $calls == 3;
    return CORE::close($_[0]);
  };
}
1;
`);
await fs.writeFile(path.join(perlFaults, 'FailRename.pm'), `package FailRename;
use strict;
use Errno qw(EACCES);
BEGIN { *CORE::GLOBAL::rename = sub { $! = EACCES; return 0; }; }
1;
`);

function runPrivacy(mode, file, ledger, input = '') {
  return spawnSync('/usr/bin/perl', [privacy, mode, file], {
    encoding: 'utf8', input,
    env: { ...process.env, HOME: home, NB_PRIVACY_FILE: ledger },
  });
}
function privacyPath(label) { return path.join(temp, `${label}.tsv`); }
function makeFixture(label) {
  const root = path.join(temp, label, 'Documents');
  const moc = path.join(temp, label, 'DataBrain', 'moc');
  const source = path.join(root, 'ordinary.rtf');
  const index = path.join(moc, 'index.tsv');
  const ledger = path.join(temp, label, 'privacy.tsv');
  return { root, moc, source, index, ledger };
}
async function seedExtractFixture(fixture, text = privateText) {
  await fs.mkdir(fixture.root, { recursive: true });
  await fs.mkdir(fixture.moc, { recursive: true });
  await fs.writeFile(fixture.source, `{\\rtf1\\ansi ${text}}\n`);
  await fs.writeFile(fixture.index, `# canonical_path\ttitle\tthemes\tkeywords\n${fixture.source}\tSynthetic ordinary note\tfixture\t-\n`);
  await fs.writeFile(fixture.ledger, '');
  return fs.readFile(fixture.source);
}
function extractionEnv(fixture) {
  const roots = path.join(path.dirname(fixture.root), 'roots.txt');
  return {
    ...process.env,
    HOME: home,
    NB_MOC_DIR: fixture.moc,
    NB_CANON_ROOTS_FILE: roots,
    NB_PRIVACY_FILE: fixture.ledger,
  };
}
async function writeRootGrant(fixture) {
  await fs.writeFile(path.join(path.dirname(fixture.root), 'roots.txt'), `${fixture.root}\n`);
}
function runExtract(fixture, args = [], extraEnv = {}) {
  return spawnSync('/bin/bash', [extract, ...args], { encoding: 'utf8', env: { ...extractionEnv(fixture), ...extraEnv } });
}
async function ftsSearch(fixture, query) {
  const env = { ...extractionEnv(fixture), NB_FTS_COUNT: '1' };
  const build = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-fts.sh')], { encoding: 'utf8', env });
  assert.equal(build.status, 0, `build-fts failed: ${build.stderr || build.stdout}`);
  return searchExistingFts(fixture, query);
}
function searchExistingFts(fixture, query) {
  const env = { ...extractionEnv(fixture), NB_FTS_COUNT: '1' };
  const search = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), query, '10'], { encoding: 'utf8', env });
  return search;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function startMcpFixture(label) {
  const base = path.join(temp, label);
  const mcpHome = path.join(base, 'home');
  const docs = path.join(base, 'Documents');
  const dataHome = path.join(mcpHome, 'DataBrain');
  const source = path.join(docs, 'ordinary.rtf');
  const datalessList = path.join(base, 'dataless.txt');
  await fs.mkdir(mcpHome, { recursive: true });
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(source, '{\\rtf1\\ansi SYNTHETIC BENIGN MCP CONTROL.}\n');
  const child = spawn(process.execPath, [path.join(engine, 'setup', 'mcp', 'server.mjs'), '--databrain-source-roots', docs], {
    env: { ...process.env, HOME: mcpHome, DATABRAIN_TEST_PARENT: mcpHome, DATABRAIN_TEST_PRIVACY_CONSENT: 'yes', NB_TEST_DATALESS_LIST: datalessList },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const waiting = new Map();
  const stderr = [];
  child.stderr.setEncoding('utf8').on('data', chunk => stderr.push(chunk));
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try { const message = JSON.parse(line); waiting.get(message.id)?.(message); }
    catch (error) { stderr.push(`\ninvalid MCP output: ${error.message}\n${line}`); }
  });
  let id = 0;
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => { waiting.delete(requestId); reject(new Error(`MCP request timed out: ${method}\n${stderr.join('')}`)); }, 60000);
    waiting.set(requestId, message => { clearTimeout(timer); resolve(message); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const reply = await rpc('tools/call', { name, arguments: args });
    assert(!reply.error, `${name} returned an MCP error: ${JSON.stringify(reply.error)}\n${stderr.join('')}`);
    return reply.result?.content?.[0]?.text ?? '';
  };
  return { base, child, home: mcpHome, dataHome, docs, datalessList, rpc, call, source, stderr };
}
async function assertNoFtsCanary(fixture, query = canary) {
  const result = await ftsSearch(fixture, query);
  assert.equal(result.status, 0, `fts search failed: ${result.stderr || result.stdout}`);
  assert.match(result.stdout, /^matches: 0$/m, `the excerpt must not match FTS: ${result.stdout}`);
  assert.doesNotMatch(result.stdout, /ordinary\.rtf/, 'a result for the synthetic source would expose its body');
}

try {
  // A writable control proves this exact synthetic pattern reaches the held-ledger append branch.
  const controlLedger = privacyPath('writable-control');
  const controlPath = path.join(temp, 'control-source.rtf');
  await fs.writeFile(controlLedger, '');
  const control = runPrivacy('content', controlPath, controlLedger, privateText);
  assert.equal(control.status, 0, control.stderr);
  assert.match(control.stdout, /contains a password/);
  assert.match(await fs.readFile(controlLedger, 'utf8'), new RegExp(`^held\\t${escapeRegex(controlPath)}\\tcontains a password$`, 'm'));

  // An absent ledger is an unknown clean state.
  const missingLedger = privacyPath('unknown-clean');
  const clean = runPrivacy('content', path.join(temp, 'clean.rtf'), missingLedger, 'ordinary harmless synthetic note');
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stdout, '');

  // A readable but unwritable ledger reaches the append branch and must fail on recognized content.
  const appendFailure = privacyPath('append-failure');
  await fs.writeFile(appendFailure, '');
  await fs.chmod(appendFailure, 0o444);
  await fs.access(appendFailure, constants.R_OK);
  await assert.rejects(fs.access(appendFailure, constants.W_OK));
  const append = runPrivacy('content', path.join(temp, 'append-source.rtf'), appendFailure, privateText);
  assert.notEqual(append.status, 0, 'recognized private content must propagate a ledger append failure');
  assert.equal(await fs.readFile(appendFailure, 'utf8'), '', 'failed append must leave the ledger unchanged');
  await fs.chmod(appendFailure, 0o600);

  // Keep an unsafe matching-fingerprint sidecar in an already-built MCP FTS database.
  // The canary is far from the fake password marker, so screening the whole indexed body matters.
  const mcp = await startMcpFixture('mcp-existing-fts');
  try {
    await mcp.rpc('initialize', { protocolVersion: '2025-03-26' });
    mcp.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await mcp.call('databrain_setup_start');
    const readyDeadline = Date.now() + 120000;
    let setupStatus = '';
    while (Date.now() < readyDeadline) {
      setupStatus = await mcp.call('databrain_setup_status');
      if (/Stage: ready\./.test(setupStatus)) break;
      await sleep(300);
    }
    assert.match(setupStatus, /Stage: ready\./, `synthetic MCP setup did not reach ready:\n${setupStatus}`);
    const mcpMoc = path.join(mcp.dataHome, 'moc');
    const mcpLedger = path.join(mcp.dataHome, '.databrain', 'privacy.tsv');
    const mcpIndex = path.join(mcpMoc, 'index.tsv');
    const mcpRoots = path.join(mcp.dataHome, '.source-roots');
    const mcpStat = spawnSync('/usr/bin/stat', ['-f', '%i:%z:%m:%c', mcp.source], { encoding: 'utf8' });
    assert.equal(mcpStat.status, 0, mcpStat.stderr);
    const sourceBefore = createHash('sha256').update(await fs.readFile(mcp.source)).digest('hex');
    const sidecarFiles = await fs.readdir(path.join(mcpMoc, 'extracted'));
    const sidecarMatches = await Promise.all(sidecarFiles.map(async name => ({ name, content: await fs.readFile(path.join(mcpMoc, 'extracted', name), 'utf8') })));
    const existingSidecar = sidecarMatches.find(candidate => candidate.content.includes('ordinary.rtf'));
    assert(existingSidecar, 'setup should have produced an extracted cache for the synthetic RTF source');
    const mcpSidecar = path.join(mcpMoc, 'extracted', existingSidecar.name);
    const header = existingSidecar.content.match(/^(<!-- newbrain-extract source: [^\n]+ -->\n<!-- newbrain-extract fingerprint: [^\n]+ -->\n\n)/u)?.[1];
    assert(header, `the setup sidecar must carry its source and fingerprint headers: ${existingSidecar.name}`);
    assert.match(header, new RegExp(`fingerprint: ${mcpStat.stdout.trim().replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}`), 'unsafe cached content keeps the real current source fingerprint');
    const mcpStored = header.match(/^<!-- newbrain-extract source: ([^\n]+) -->/u)?.[1];
    assert(mcpStored, 'setup sidecar must name its source path');
    const boundaryLabel = 'fake password:';
    const boundaryPrefix = `${canary} ${'x'.repeat(20000 - canary.length - boundaryLabel.length - 2)} `;
    const multiSectionPrivateText = `${boundaryPrefix}${boundaryLabel} Example-Only-not-a-credential-9${'harmlesssyntheticfillertext'.repeat(31000)}`;
    assert.equal(multiSectionPrivateText.indexOf(boundaryLabel) + boundaryLabel.length, 20000, 'the synthetic password label must end at the exact 20,000-character FTS section boundary');
    assert.doesNotMatch(multiSectionPrivateText, /\n/, 'the section-boundary fixture must be one long line');
    await fs.writeFile(mcpSidecar, `${header}${multiSectionPrivateText}\n`);
    const mcpEnv = { ...process.env, HOME: mcp.home, NB_MOC_DIR: mcpMoc, NB_CANON_ROOTS_FILE: mcpRoots, NB_PRIVACY_FILE: mcpLedger, NB_FTS_COUNT: '1' };
    const mcpBuild = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-fts.sh')], { encoding: 'utf8', env: mcpEnv });
    assert.equal(mcpBuild.status, 0, `preseed FTS failed: ${mcpBuild.stderr || mcpBuild.stdout}`);
    const sectionCount = spawnSync('/usr/bin/sqlite3', ['-readonly', path.join(mcpMoc, 'fts.db'), `SELECT COUNT(*) FROM notes WHERE path = '${mcpStored.replace(/'/g, "''")}';`], { encoding: 'utf8' });
    assert.equal(sectionCount.status, 0, sectionCount.stderr);
    assert(Number(sectionCount.stdout.trim()) > 1, `the synthetic private body must occupy multiple indexed rows, got ${sectionCount.stdout.trim()}`);
    const rawBefore = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), canary, '10'], { encoding: 'utf8', env: mcpEnv });
    assert.equal(rawBefore.status, 0, rawBefore.stderr);
    assert.match(rawBefore.stdout, /^matches: 1$/m, `the unsafe indexed body must match before MCP screening: ${rawBefore.stdout}`);
    assert.match(rawBefore.stdout, /ordinary\.rtf/, rawBefore.stdout);
    const priorMcpIndex = await fs.readFile(mcpIndex, 'utf8');
    await fs.chmod(mcpLedger, 0o444);
    await fs.access(mcpLedger, constants.R_OK);
    await assert.rejects(fs.access(mcpLedger, constants.W_OK));
    const searchResult = await mcp.call('databrain_search', { query: canary, limit: 3 });
    assert.match(searchResult, /Results 1-1 of 1\./, `MCP search must still return the actual existing FTS hit:\n${searchResult}`);
    assert.match(searchResult, /^\s*1\s+-?[0-9.]+\s+.*ordinary\.rtf/m, `search should retain path/rank metadata while withholding only the excerpt:\n${searchResult}`);
    assert.doesNotMatch(searchResult, new RegExp(canary, 'i'), `MCP must not return a faraway indexed canary after the privacy append fails:\n${searchResult}`);
    assert.match(searchResult, /Privacy screen (?:could not verify|withheld)/i, `MCP should explain that the excerpt was withheld:\n${searchResult}`);
    const rawAfter = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), canary, '10'], { encoding: 'utf8', env: mcpEnv });
    assert.equal(rawAfter.status, 0, rawAfter.stderr);
    assert.match(rawAfter.stdout, /^matches: 1$/m, 'MCP screening must not rebuild or mutate the existing FTS database');
    assert.equal(await fs.readFile(mcpIndex, 'utf8'), priorMcpIndex, 'search screening must not mutate the index');
    assert.equal(createHash('sha256').update(await fs.readFile(mcp.source)).digest('hex'), sourceBefore, 'MCP privacy checks must not modify the source bytes');

    // The test-only dataless marker exercises the cached-read branch without opening the source.
    await fs.writeFile(mcp.datalessList, `${mcp.source}\n`);
    await fs.chmod(mcp.source, 0o000);
    const readResult = await mcp.call('databrain_read', { path: mcp.source });
    assert.match(readResult, /now online-only in a cloud drive/, `the test must reach the dataless cached-text branch:\n${readResult}`);
    assert.doesNotMatch(readResult, new RegExp(canary, 'i'), `online-only cached read must withhold the indexed canary:\n${readResult}`);
    assert.match(readResult, /does not show indexed text that is held back or cannot be privacy-checked/i, `online-only cached read should say the excerpt was withheld:\n${readResult}`);
    await fs.chmod(mcpLedger, 0o600);
  } finally {
    await fs.chmod(mcp.source, 0o600).catch(() => {});
    mcp.child.kill('SIGKILL');
    await sleep(100);
    await fs.rm(mcp.base, { recursive: true, force: true });
  }

  // Seed a real FTS hit from an unsafe matching-fingerprint cache before the privacy failure.
  const cached = makeFixture('cached-extract');
  const cachedSourceBytes = await seedExtractFixture(cached, 'SYNTHETIC TEST ONLY; harmless source text.');
  await writeRootGrant(cached);
  const sourceStat = spawnSync('/usr/bin/stat', ['-f', '%i:%z:%m:%c', cached.source], { encoding: 'utf8' });
  assert.equal(sourceStat.status, 0, sourceStat.stderr);
  const sourcePathHash = createHash('sha1').update(cached.source).digest('hex').slice(0, 16);
  const sidecar = path.join(cached.moc, 'extracted', `${sourcePathHash}.txt`);
  await fs.mkdir(path.dirname(sidecar), { recursive: true });
  await fs.writeFile(sidecar, `<!-- newbrain-extract source: ${cached.source} -->\n<!-- newbrain-extract fingerprint: ${sourceStat.stdout.trim()} -->\n\n${privateText}\n`);
  const priorSearch = await ftsSearch(cached, canary);
  assert.equal(priorSearch.status, 0, `pre-failure FTS search failed: ${priorSearch.stderr || priorSearch.stdout}`);
  assert.match(priorSearch.stdout, /^matches: 1$/m, `the unsafe cache must be in the existing FTS database: ${priorSearch.stdout}`);
  assert.match(priorSearch.stdout, /ordinary\.rtf/, priorSearch.stdout);
  await fs.chmod(cached.ledger, 0o444);
  const cachedIndex = await fs.readFile(cached.index, 'utf8');
  const cachedFailure = runExtract(cached);
  assert.notEqual(cachedFailure.status, 0, `cached private content must be screened before cache reuse: ${cachedFailure.stdout}\n${cachedFailure.stderr}`);
  assert.equal(await fs.readFile(cached.index, 'utf8'), cachedIndex, 'cache-screen failure must preserve the index');
  assert.equal(createHash('sha256').update(await fs.readFile(cached.source)).digest('hex'), createHash('sha256').update(cachedSourceBytes).digest('hex'));
  await fs.chmod(cached.ledger, 0o600);
  assert.equal(await fs.stat(sidecar).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error)), null, 'failed privacy screening must remove the unsafe derived cache');
  const cachedAfterFailure = searchExistingFts(cached, canary);
  assert.equal(cachedAfterFailure.status, 0, `the prebuilt FTS database must remain readable: ${cachedAfterFailure.stderr}`);
  assert.match(cachedAfterFailure.stdout, /^matches: 1$/m, 'raw FTS remains stale until its normal rebuild; MCP must withhold the excerpt at read time');

  // If a held cache cannot be removed, extraction must still stop and preserve the prior index.
  const cleanupFailure = makeFixture('cached-cleanup-failure');
  const cleanupSourceBytes = await seedExtractFixture(cleanupFailure);
  await writeRootGrant(cleanupFailure);
  const cleanupSourceStat = spawnSync('/usr/bin/stat', ['-f', '%i:%z:%m:%c', cleanupFailure.source], { encoding: 'utf8' });
  assert.equal(cleanupSourceStat.status, 0, cleanupSourceStat.stderr);
  const cleanupHash = createHash('sha1').update(cleanupFailure.source).digest('hex').slice(0, 16);
  const cleanupSidecar = path.join(cleanupFailure.moc, 'extracted', `${cleanupHash}.txt`);
  await fs.mkdir(path.dirname(cleanupSidecar), { recursive: true });
  const cleanupSidecarBytes = `<!-- newbrain-extract source: ${cleanupFailure.source} -->\n<!-- newbrain-extract fingerprint: ${cleanupSourceStat.stdout.trim()} -->\n\n${privateText}\n`;
  await fs.writeFile(cleanupSidecar, cleanupSidecarBytes);
  const cleanupPriorIndex = await fs.readFile(cleanupFailure.index, 'utf8');
  await fs.chmod(path.dirname(cleanupSidecar), 0o555);
  const failedCleanup = runExtract(cleanupFailure);
  await fs.chmod(path.dirname(cleanupSidecar), 0o755);
  assert.notEqual(failedCleanup.status, 0, 'failure to remove a recognized-private cached extract must fail extraction');
  assert.match(failedCleanup.stderr, /cached extract could not be removed/i, `cleanup failure should be reported generically:\n${failedCleanup.stderr}`);
  assert.equal(await fs.readFile(cleanupFailure.index, 'utf8'), cleanupPriorIndex, 'failed cleanup must preserve the index');
  assert.equal(await fs.readFile(cleanupSidecar, 'utf8'), cleanupSidecarBytes, 'failed cleanup must preserve the prior cache bytes');
  assert.equal(createHash('sha256').update(await fs.readFile(cleanupFailure.source)).digest('hex'), createHash('sha256').update(cleanupSourceBytes).digest('hex'));

  // A real extraction with an append failure must publish no sidecar, keyword, or index update.
  const fresh = makeFixture('fresh-extract');
  const sourceBytes = await seedExtractFixture(fresh);
  await writeRootGrant(fresh);
  await fs.chmod(fresh.ledger, 0o444);
  const beforeIndex = await fs.readFile(fresh.index, 'utf8');
  const beforeSourceHash = createHash('sha256').update(sourceBytes).digest('hex');
  const failedExtract = runExtract(fresh, ['--force']);
  assert.notEqual(failedExtract.status, 0, `extract must stop when its privacy ledger append fails: ${failedExtract.stdout}\n${failedExtract.stderr}`);
  assert.doesNotMatch(`${failedExtract.stdout}\n${failedExtract.stderr}`, new RegExp(canary, 'i'), 'failure output must not disclose the synthetic excerpt');
  assert.equal(await fs.readFile(fresh.index, 'utf8'), beforeIndex, 'failed privacy screening must not publish keywords or prune the index');
  assert.equal(createHash('sha256').update(await fs.readFile(fresh.source)).digest('hex'), beforeSourceHash, 'source bytes must remain unchanged');
  assert.deepEqual(await fs.readdir(path.join(fresh.moc, 'extracted')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [], 'failed extraction must publish no sidecar');
  await fs.chmod(fresh.ledger, 0o600);
  await assertNoFtsCanary(fresh);

  // A benign positive control proves extraction, keyword publication, and full-text search still work.
  const benign = makeFixture('benign-control');
  const benignBytes = await seedExtractFixture(benign, `SYNTHETIC BENIGN CONTROL ${benignCanary} ordinary garden note.`);
  await writeRootGrant(benign);
  const benignExtract = runExtract(benign, ['--force']);
  assert.equal(benignExtract.status, 0, `${benignExtract.stdout}\n${benignExtract.stderr}`);
  assert.equal(createHash('sha256').update(await fs.readFile(benign.source)).digest('hex'), createHash('sha256').update(benignBytes).digest('hex'));
  assert.notEqual((await fs.readFile(benign.index, 'utf8')).split('\n')[1]?.split('\t')[3], '-', 'benign extraction should publish derived keywords');
  const benignHash = createHash('sha1').update(benign.source).digest('hex').slice(0, 16);
  assert.match(await fs.readFile(path.join(benign.moc, 'extracted', `${benignHash}.txt`), 'utf8'), new RegExp(benignCanary));
  const benignSearch = await ftsSearch(benign, benignCanary);
  assert.equal(benignSearch.status, 0, `benign FTS search failed: ${benignSearch.stderr || benignSearch.stdout}`);
  assert.match(benignSearch.stdout, /^matches: 1$/m, `benign positive control must be searchable: ${benignSearch.stdout}`);
  assert.match(benignSearch.stdout, /ordinary\.rtf/, benignSearch.stdout);

  // A locally present but unreadable text file keeps its metadata, never reuses its stale sidecar body.
  const unreadableSourceFixture = makeFixture('unreadable-local-source');
  unreadableSourceFixture.source = path.join(unreadableSourceFixture.root, 'ordinary.txt');
  const unreadableText = `SYNTHETIC TEST ONLY; source body marker ${canary}; intentionally unreadable later.`;
  await fs.mkdir(unreadableSourceFixture.root, { recursive: true });
  await fs.mkdir(unreadableSourceFixture.moc, { recursive: true });
  await fs.writeFile(unreadableSourceFixture.source, unreadableText);
  await fs.writeFile(unreadableSourceFixture.index, `# canonical_path\ttitle\tthemes\tkeywords\n${unreadableSourceFixture.source}\tUnreadable synthetic note\tfixture\t-\n`);
  await fs.writeFile(unreadableSourceFixture.ledger, '');
  await writeRootGrant(unreadableSourceFixture);
  const unreadableStat = spawnSync('/usr/bin/stat', ['-f', '%i:%z:%m:%c', unreadableSourceFixture.source], { encoding: 'utf8' });
  assert.equal(unreadableStat.status, 0, unreadableStat.stderr);
  const unreadableHash = createHash('sha1').update(unreadableSourceFixture.source).digest('hex').slice(0, 16);
  const unreadableSidecar = path.join(unreadableSourceFixture.moc, 'extracted', `${unreadableHash}.txt`);
  await fs.mkdir(path.dirname(unreadableSidecar), { recursive: true });
  const unreadableSidecarBytes = `<!-- newbrain-extract source: ${unreadableSourceFixture.source} -->\n<!-- newbrain-extract fingerprint: ${unreadableStat.stdout.trim()} -->\n\nSYNTHETIC OLD EXTRACT ${canary}\n`;
  await fs.writeFile(unreadableSidecar, unreadableSidecarBytes);
  const unreadableEnv = { ...extractionEnv(unreadableSourceFixture), NB_TEST_DATALESS_LIST: '', NB_FTS_COUNT: '1' };
  const oldUnreadableFtsBuild = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-fts.sh')], { encoding: 'utf8', env: unreadableEnv });
  assert.equal(oldUnreadableFtsBuild.status, 0, `seed prior FTS failed: ${oldUnreadableFtsBuild.stderr || oldUnreadableFtsBuild.stdout}`);
  const oldUnreadableHit = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), canary, '10'], { encoding: 'utf8', env: unreadableEnv });
  assert.equal(oldUnreadableHit.status, 0, oldUnreadableHit.stderr);
  assert.match(oldUnreadableHit.stdout, /^matches: 1$/m, `the stale sidecar body should be indexed before the permission change: ${oldUnreadableHit.stdout}`);
  const unreadableIndexBefore = await fs.readFile(unreadableSourceFixture.index, 'utf8');
  await fs.chmod(unreadableSourceFixture.source, 0o000);
  const unreadableExtract = runExtract(unreadableSourceFixture, [], { NB_TEST_DATALESS_LIST: '' });
  assert.equal(unreadableExtract.status, 0, `an unreadable metadata row is retained without aborting extraction: ${unreadableExtract.stdout}\n${unreadableExtract.stderr}`);
  const unreadableReport = await fs.readFile(path.join(unreadableSourceFixture.moc, 'extract-report.tsv'), 'utf8');
  assert.match(unreadableReport, new RegExp(`${escapeRegex(unreadableSourceFixture.source)}\\topen_failed`), `the local unreadable row should be reported, not treated as cloud-only:\n${unreadableReport}\n${unreadableExtract.stdout}\n${unreadableExtract.stderr}`);
  assert.equal(await fs.readFile(unreadableSourceFixture.index, 'utf8'), unreadableIndexBefore, 'unreadable source metadata must remain indexed');
  assert.equal(await fs.readFile(unreadableSidecar, 'utf8'), unreadableSidecarBytes, 'the old sidecar may remain, but must not be treated as current content');
  const newUnreadableFtsBuild = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-fts.sh')], { encoding: 'utf8', env: unreadableEnv });
  assert.equal(newUnreadableFtsBuild.status, 0, `incremental FTS rebuild failed: ${newUnreadableFtsBuild.stderr || newUnreadableFtsBuild.stdout}`);
  const noUnreadableBody = spawnSync('/usr/bin/sqlite3', ['-readonly', path.join(unreadableSourceFixture.moc, 'fts.db'), `SELECT COUNT(*) FROM notes WHERE path = '${unreadableSourceFixture.source.replace(/'/g, "''")}' AND length(body) > 0;`], { encoding: 'utf8' });
  assert.equal(noUnreadableBody.status, 0, noUnreadableBody.stderr);
  assert.equal(noUnreadableBody.stdout.trim(), '0', 'incremental FTS must revoke the stale sidecar body for a locally unreadable source');
  const noUnreadableHit = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), canary, '10'], { encoding: 'utf8', env: unreadableEnv });
  assert.equal(noUnreadableHit.status, 0, noUnreadableHit.stderr);
  assert.match(noUnreadableHit.stdout, /^matches: 0$/m, `the old private-content surrogate must be absent after the rebuild: ${noUnreadableHit.stdout}`);
  await fs.chmod(unreadableSourceFixture.source, 0o600);

  // A prune rename failure in extract must propagate before its staged sidecar or index is published.
  const pruneExtract = makeFixture('extract-prune-failure');
  const pruneExtractBytes = await seedExtractFixture(pruneExtract, `SYNTHETIC BENIGN CONTROL ${benignCanary} second ordinary note.`);
  await writeRootGrant(pruneExtract);
  const pruneExtractIndex = await fs.readFile(pruneExtract.index, 'utf8');
  const failedPruneExtract = runExtract(pruneExtract, ['--force'], { PERL5LIB: perlFaults, PERL5OPT: '-MFailRename' });
  assert.notEqual(failedPruneExtract.status, 0, `extract must propagate a privacy prune rename failure: ${failedPruneExtract.stdout}\n${failedPruneExtract.stderr}`);
  assert.equal(await fs.readFile(pruneExtract.index, 'utf8'), pruneExtractIndex, 'failed extract prune must preserve the prior index');
  assert.equal(createHash('sha256').update(await fs.readFile(pruneExtract.source)).digest('hex'), createHash('sha256').update(pruneExtractBytes).digest('hex'));
  assert.deepEqual(await fs.readdir(path.join(pruneExtract.moc, 'extracted')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error)), [], 'failed extract prune must publish no sidecar');
  await assertNoFtsCanary(pruneExtract, benignCanary);

  // An existing unreadable ledger is an error, unlike the absent-ledger control above.
  const readFailure = privacyPath('read-failure');
  await fs.writeFile(readFailure, '');
  await fs.chmod(readFailure, 0o000);
  await assert.rejects(fs.access(readFailure, constants.R_OK));
  const unreadable = runPrivacy('content', path.join(temp, 'unreadable-source.rtf'), readFailure, 'ordinary harmless synthetic note');
  assert.notEqual(unreadable.status, 0, 'an unreadable ledger must not be treated as an absent, empty ledger');
  await fs.chmod(readFailure, 0o600);

  // A failed prune write must preserve the old index bytes.
  const pruneDir = path.join(temp, 'prune');
  const pruneIndex = path.join(pruneDir, 'index.tsv');
  const pruneLedger = path.join(pruneDir, 'privacy.tsv');
  await fs.mkdir(pruneDir, { recursive: true });
  const priorIndex = `# canonical_path\ttitle\tthemes\tkeywords\n${controlPath}\tPrior synthetic row\tfixture\tpriorword\n`;
  await fs.writeFile(pruneIndex, priorIndex);
  await fs.writeFile(pruneLedger, `held\t${controlPath}\tsynthetic test hold\n`);
  await fs.chmod(pruneDir, 0o555);
  const prune = spawnSync('/usr/bin/perl', [privacy, 'prune-index', pruneIndex], {
    encoding: 'utf8', env: { ...process.env, HOME: home, NB_PRIVACY_FILE: pruneLedger },
  });
  await fs.chmod(pruneDir, 0o755);
  assert.notEqual(prune.status, 0, 'prune write failure must propagate');
  assert.equal(await fs.readFile(pruneIndex, 'utf8'), priorIndex, 'failed prune must preserve the previous index');

  // Perl test-only fault wrappers make close and rename failures deterministic on macOS.
  for (const module of ['FailClose', 'FailRename']) {
    const faultDir = path.join(temp, `prune-${module}`);
    const faultIndex = path.join(faultDir, 'index.tsv');
    const faultLedger = path.join(faultDir, 'privacy.tsv');
    await fs.mkdir(faultDir, { recursive: true });
    await fs.writeFile(faultIndex, priorIndex);
    await fs.writeFile(faultLedger, `held\t${controlPath}\tsynthetic test hold\n`);
    const failedPrune = spawnSync('/usr/bin/perl', ['-I', perlFaults, `-M${module}`, privacy, 'prune-index', faultIndex], {
      encoding: 'utf8', env: { ...process.env, HOME: home, NB_PRIVACY_FILE: faultLedger },
    });
    assert.notEqual(failedPrune.status, 0, `${module} failure must propagate from prune-index`);
    assert.equal(await fs.readFile(faultIndex, 'utf8'), priorIndex, `${module} failure must preserve the prior index`);
    assert.deepEqual((await fs.readdir(faultDir)).sort(), ['index.tsv', 'privacy.tsv'], `${module} failure must clean its staged file`);
  }

  console.log('PASS: privacy ledger read/append and prune failures fail closed; fresh and matching-fingerprint cached extraction failures publish no private excerpt, keywords, or index changes.');
} finally {
  await fs.chmod(path.join(temp, 'append-failure.tsv'), 0o600).catch(() => {});
  await fs.chmod(path.join(temp, 'prune'), 0o755).catch(() => {});
  await fs.chmod(path.join(temp, 'cached-cleanup-failure', 'DataBrain', 'moc', 'extracted'), 0o755).catch(() => {});
  await fs.chmod(path.join(temp, 'unreadable-local-source', 'Documents', 'ordinary.txt'), 0o600).catch(() => {});
  await fs.rm(temp, { recursive: true, force: true });
}
