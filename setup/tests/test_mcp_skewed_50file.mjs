// Disposable skewed-corpus acceptance probe through the packaged MCP server.
// This proves fixture indexing, metadata-only taxonomy proposals, keyword search,
// health, and abstention mechanics; it is not evidence of personal-corpus recall.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const [engine] = process.argv.slice(2);
assert(engine, 'usage: test_mcp_skewed_50file.mjs PACKAGED_ENGINE_DIRECTORY');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-skewed-50-')));
const home = path.join(temp, 'home');
const desktop = path.join(home, 'Desktop');
const dataHome = path.join(desktop, 'DataBrain');
const corpus = path.join(temp, 'synthetic-approved-sources');
const selectionFile = path.join(temp, 'selection.txt');
const categories = [
  ['projects', 20], ['research', 12], ['operations', 8],
  ['finance', 2], ['health', 2], ['learning', 2], ['travel', 1],
  ['writing', 1], ['people', 1], ['products', 1],
];
assert.equal(categories.length, 10);
assert.equal(categories.reduce((sum, [, count]) => sum + count, 0), 50);
assert.deepEqual(categories.slice(0, 3).map(([, count]) => count), [20, 12, 8]);

await fs.mkdir(desktop, { recursive: true });
await fs.mkdir(corpus);
const canonicalCorpus = await fs.realpath(corpus);
const expected = [];
let sequence = 0;
for (const [category, count] of categories) {
  const folder = path.join(canonicalCorpus, category);
  await fs.mkdir(folder);
  for (let offset = 1; offset <= count; offset += 1) {
    sequence += 1;
    const filename = `${category}-${String(offset).padStart(2, '0')}.md`;
    const target = path.join(folder, filename);
    const keyword = `selectedkw${sequence}`;
    const anchor = `corpusanchor${sequence}`;
    const bodySentinel = `BODY_SENTINEL_${sequence}_MUST_NOT_APPEAR_IN_PROPOSAL`;
    await fs.writeFile(target, [
      '---',
      `tags: [${keyword}, synthetic-${category}]`,
      '---',
      `# ${category} synthetic record ${sequence}`,
      '',
      `This disposable ${category} record carries ${keyword} and ${anchor}. ${bodySentinel}`,
      '',
    ].join('\n'));
    expected.push({ category, path: target, keyword, anchor, bodySentinel });
  }
}
assert.equal(expected.length, 50);

const server = spawn(process.execPath, [path.join(engine, 'setup/mcp/server.mjs')], {
  env: {
    ...process.env,
    HOME: home,
    DATABRAIN_ENGINE_DIR: engine,
    DATABRAIN_TEST_HOME: dataHome,
    DATABRAIN_TEST_SELECTION_FILE: selectionFile,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});
const replies = new Map();
let stderr = '';
server.stderr.setEncoding('utf8');
server.stderr.on('data', chunk => { stderr += chunk; });
readline.createInterface({ input: server.stdout }).on('line', line => {
  const message = JSON.parse(line);
  if (message.id !== undefined) replies.get(message.id)?.(message);
});
let requestId = 0;
function request(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++requestId;
    const timer = setTimeout(() => {
      replies.delete(id);
      reject(new Error(`Timed out waiting for ${method}; server stderr: ${stderr}`));
    }, 30000);
    replies.set(id, message => {
      clearTimeout(timer);
      replies.delete(id);
      if (message.error) reject(new Error(`${method}: ${message.error.message}`));
      else resolve(message.result);
    });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
}
async function call(name, args = {}) {
  const result = await request('tools/call', { name, arguments: args });
  const text = result?.content?.find(block => block.type === 'text')?.text ?? '';
  assert(!result?.isError, `${name} failed: ${text}`);
  assert(!text.startsWith('DataBrain: '), `${name} failed: ${text}`);
  return text;
}
async function waitForStatus(predicate, description) {
  let lastStatus = '';
  for (let i = 0; i < 600; i += 1) {
    lastStatus = await call('databrain_setup_status');
    if (predicate(lastStatus)) return lastStatus;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${description}; last status: ${lastStatus}`);
}

try {
  await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'disposable-skewed-corpus-fixture', version: '1' },
  });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');

  await fs.writeFile(selectionFile, `${desktop}\n`);
  await call('databrain_setup_start');
  await waitForStatus(status => status.includes('Stage: destination ready.'), 'disposable destination approval');
  await fs.writeFile(selectionFile, `${canonicalCorpus}\n`);
  await call('databrain_select_sources');
  await waitForStatus(status => status.includes('Stage: sources selected.'), 'disposable source selection');
  await call('databrain_setup_run');
  const indexedStatus = await waitForStatus(status =>
    status.includes('Stage: taxonomy pending.') && /initial indexing: complete/.test(status),
  'all 50 files indexed');
  assert.match(indexedStatus, /Indexed rows: 50\./, indexedStatus);
  assert.match(indexedStatus, /File inventory: 50 indexed, 0 eligible missing from index, 0 unsupported; unreadable 0, cloud placeholders 0, empty 0, traversal errors 0\./, indexedStatus);

  const health = await call('databrain_health');
  assert.match(health, /Index records: 50; missing 0; unsafe 0; outside approved roots 0\./, health);
  assert.match(health, /File inventory: 50 indexed; 0 eligible missing; 0 unsupported; unreadable 0; placeholders 0; empty 0; traversal errors 0\./, health);
  assert.match(health, /Source freshness: current\./, health);
  assert.match(health, /Ranked search database: 50 rows; quick_check ok\./, health);

  const proposals = await call('databrain_taxonomy_candidates');
  for (const row of categories) {
    const [name, count] = row;
    assert.match(proposals, new RegExp(`synthetic-approved-sources \\/ ${name}\\t${count} files\\t`), `missing proposal for ${name}=${count}\n${proposals}`);
  }
  assert.equal((proposals.match(/ files\t/g) || []).length, 10, `expected exactly 10 proposed categories\n${proposals}`);
  assert(!proposals.includes('BODY_SENTINEL_'), 'taxonomy candidates must never expose source body text');

  const idsByFolder = new Map();
  for (const line of proposals.split('\n').slice(1)) {
    const match = line.match(/^(folder-[a-f0-9]+)\tsynthetic-approved-sources \/ ([a-z-]+)\t(\d+) files\t/);
    assert(match, `unexpected taxonomy proposal row: ${line}`);
    idsByFolder.set(match[2], match[1]);
  }
  assert.equal(idsByFolder.size, 10);
  const assignments = categories.map(([category]) => ({
    folder_id: idsByFolder.get(category), categories: [category],
  }));
  assert(assignments.every(assignment => assignment.folder_id), 'each category needs its actual MCP proposal ID');
  await call('databrain_apply_taxonomy', { assignments });
  const taxonomyStatus = await waitForStatus(status =>
    status.includes('Stage: relationships pending.') && /taxonomy application: complete/.test(status),
  'confirmed category application');
  assert(taxonomyStatus.includes('relationships pending'));

  await call('databrain_build_relationships');
  const relationshipStatus = await waitForStatus(status =>
    status.includes('Stage: verification pending.') && /relationship report: complete/.test(status),
  'relationship report completion');
  assert(relationshipStatus.includes('Stage: verification pending.'));

  const indexText = await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
  const indexedRows = indexText.split('\n').filter(line => line && !line.startsWith('#')).map(line => line.split('\t'));
  assert.equal(indexedRows.length, 50);
  const counts = new Map();
  for (const row of indexedRows) {
    const category = row[2];
    counts.set(category, (counts.get(category) || 0) + 1);
    assert(row[3].split(',').some(keyword => keyword.startsWith('selectedkw')),
      `missing explicitly selected keyword in index row: ${row.join('\t')}`);
  }
  for (const [category, count] of categories) assert.equal(counts.get(category), count, `${category} category count`);
  assert.equal(counts.size, 10, 'confirmed index must retain exactly 10 categories');

  let misses = 0;
  const missDetails = [];
  for (const file of expected) {
    const result = await call('databrain_search', { query: file.keyword, limit: 8 });
    if (!result.split('\n').some(line => line.includes(file.path))) {
      misses += 1;
      missDetails.push(`${file.category}/${path.basename(file.path)} via ${file.keyword}`);
    }
  }
  assert.equal(misses, 0, `selected-keyword retrieval misses ${misses}/50: ${missDetails.join('; ')}`);

  const absent = await call('databrain_search', { query: 'syntheticabsentquery nofixturematch', limit: 8 });
  assert.match(absent, /no matches|no content words/i, `absent synthetic query should return no hits: ${absent}`);
  const postHealth = await call('databrain_health');
  assert.match(postHealth, /Ranked search database: 50 rows; quick_check ok\./, postHealth);
  const installAudit = await call('databrain_verify_install');
  assert.match(installAudit, /Installed DataBrain audit: PARTIAL — inspect failed or blocked checks below\./, installAudit);
  assert.match(installAudit, /(PASS|PARTIAL): Package identity — DataBrain 0\.1\.0; packaged files match their embedded digest/);
  assert.match(installAudit, /https:\/\/github\.com\/MelchiorLaTour\/data-brain\.git @ [0-9a-f]{12}/);
  assert.match(installAudit, /PASS: Selected-source health/);
  assert.match(installAudit, /(PASS|FAIL|BLOCKED): GitHub release match/);
  assert.match(installAudit, /PASS: Setup contract/);
  assert.match(installAudit, /PASS: Known-hit search\/read/);
  assert.match(installAudit, /PASS: Absent-query probe/);
  assert.match(installAudit, /PASS: Active DataBrain process — This tool call confirms the DataBrain MCP process is serving the current conversation; bundle root ".+"; loaded version 0\.1\.0; engine revision [0-9a-f]{12}\./);
  assert.match(installAudit, /BLOCKED: Original MCPB archive provenance — Claude Desktop exposes the unpacked extension/);
  assert.match(installAudit, /BLOCKED: Desktop install record and restart/);
  assert.match(installAudit, /audits that running bundle against the latest public GitHub release build record/);
  assert.match(installAudit, /offline or before a release record is published/);
  assert(!installAudit.includes('BODY_SENTINEL_'), 'install audit must not return source excerpts');
  process.stdout.write([
    'PASS: isolated packaged MCP setup indexed and inventoried all 50 disposable files.',
    'Taxonomy proposals exposed exactly 10 metadata-only folder groups with counts 20/12/8 plus 2/2/2/1/1/1/1; confirmed index preserved all category counts.',
    'Explicitly selected keyword search: 50/50 files; absent synthetic query: no hits.',
    'Installed-bundle audit compares against the latest public GitHub release record and checks setup/inventory health, confirmed labels/relationships, one safe search/read, and an absent-query probe; it returns no source excerpts.',
    'Scope: synthetic lexical plumbing only; this does not validate personal-corpus relevance, semantic paraphrase, translation, or plausible false-hit judgment.',
  ].join('\n') + '\n');
} catch (error) {
  if (missesForError(error)) process.stderr.write(`${error.message}\n`);
  throw error;
} finally {
  server.kill('SIGTERM');
  if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  await fs.rm(temp, { recursive: true, force: true });
}

function missesForError(error) {
  return /selected-keyword retrieval misses/.test(error.message);
}
