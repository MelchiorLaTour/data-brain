// Compare one disposable corpus through the terminal engine, Claude-mode MCP,
// and the packaged Codex-mode MCP. This is mechanics parity, not model quality.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const [bundleArg] = process.argv.slice(2);
assert(bundleArg, 'usage: node setup/tests/test_codex_parity.mjs "path/DataBrain MCP.app"');
const bundle = path.resolve(bundleArg);
const resources = path.join(bundle, 'Contents/Resources');
const launcher = path.join(bundle, 'Contents/MacOS/databrain-mcp');
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-codex-parity-')));
const corpus = path.join(temp, 'approved Sources Café');
const rootsFile = path.join(temp, 'terminal-roots.txt');
const terminalMoc = path.join(temp, 'terminal-moc');
const projects = path.join(corpus, 'Projects');
const research = path.join(corpus, 'Research');
const files = [
  path.join(projects, 'quarterly-roadmap.md'),
  path.join(projects, 'delivery-checklist.md'),
  path.join(research, 'capacity-study.md'),
  path.join(research, 'capacity-study-copy.md'),
  path.join(research, 'response.txt'),
];
const bodies = [
  '# Quarterly roadmap\n\nThe launch forecast assigns the release owner to the delivery team. The approved plan sets a ceiling of twelve workdays.\n',
  '# Delivery checklist\n\nThe team confirms dependencies, records readiness, and links to [the quarterly roadmap](quarterly-roadmap.md).\n',
  '# Capacity study\n\nThe study compares staffing capacity with seasonal demand and records the evidence used for the forecast.\n',
  '# Capacity study\n\nThe study compares staffing capacity with seasonal demand and records the evidence used for the forecast.\n',
  'The response guide routes an overnight outage to the on-call engineer and asks the incident lead to record recovery time.\n',
];

function run(command, args, env, label) {
  const result = spawnSync(command, args, { encoding: 'utf8', env, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, `${label} failed: ${result.stderr || result.stdout}`);
  return result.stdout;
}
function terminal(script, args = []) {
  return run('/bin/bash', [path.join(repo, 'bin', script), ...args], terminalEnv, `Terminal ${script}`);
}
const terminalEnv = {
  ...process.env,
  HOME: temp,
  PATH: [path.dirname(process.execPath), '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(path.delimiter),
  NB_MOC_DIR: terminalMoc,
  NB_CANON_ROOTS_FILE: rootsFile,
};
await fs.mkdir(projects, { recursive: true });
await fs.mkdir(research, { recursive: true });
await fs.mkdir(terminalMoc, { recursive: true });
await fs.writeFile(rootsFile, `${corpus}\n`, { mode: 0o600 });
for (let i = 0; i < files.length; i += 1) {
  const frontmatter = i === 0 ? '---\ntags: [launch, roadmap]\n---\n' : '';
  await fs.writeFile(files[i], frontmatter + bodies[i]);
}
const originalSnapshots = await Promise.all(files.map(file => fs.readFile(file)));

function normalizeGenerated(text) {
  return text.replaceAll(temp, '<TEMP>').replaceAll(`~${path.sep}`, '<TEMP>/')
    .replace(/Generated \d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, 'Generated <TIME>');
}
function rankedTokens(text) {
  return [...text.matchAll(/^\s*\d+\s+-?\d+(?:\.\d+)?\s+(.+)$/gm)]
    .map(match => decodeURIComponent(match[1].trim().replace(/\+/g, ' ')));
}
function normalizeHit(value) {
  const result = value.startsWith(`~${path.sep}`) ? path.join(temp, value.slice(2)) : value;
  return result.startsWith(`${corpus}${path.sep}`) ? path.relative(corpus, result) : result;
}
function rankedPaths(text) {
  return rankedTokens(text).map(normalizeHit);
}
function taxonomyMap(text) {
  const rows = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^(folder-[a-f0-9]+)\t(.+)\t(\d+) files\t/);
    if (!match) continue;
    if (match[2].endsWith(' / Projects')) rows.set('Projects', match[1]);
    if (match[2].endsWith(' / Research')) rows.set('Research', match[1]);
  }
  return rows;
}

function startServer(command, args, env, label) {
  const server = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let stderr = '';
  let id = 0;
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', chunk => { if (stderr.length < 10000) stderr += chunk; });
  readline.createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const requestId = ++id;
      const timer = setTimeout(() => {
        replies.delete(requestId);
        reject(new Error(`${label} ${method} timed out; stderr: ${stderr}`));
      }, 30000);
      replies.set(requestId, message => {
        clearTimeout(timer);
        replies.delete(requestId);
        if (message.error) reject(new Error(`${label} ${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
    });
  }
  async function call(name, args = {}) {
    const result = await request('tools/call', { name, arguments: args });
    const text = result?.content?.find(block => block.type === 'text')?.text ?? '';
    assert(!result?.isError && !text.startsWith('DataBrain: '), `${label} ${name} failed: ${text}`);
    return text;
  }
  return { server, request, call, stderr: () => stderr };
}

async function waitFor(client, predicate, description) {
  let last = '';
  for (let i = 0; i < 2400; i += 1) {
    last = await client.call('databrain_setup_status');
    if (predicate(last)) return last;
    if (/Background job [0-9a-f-]+: failed\b|\bfailed\s+[—:-]/i.test(last)) throw new Error(`${description} failed: ${last}`);
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`${description} timed out: ${last}`);
}

async function runMcpMode(mode) {
  const home = path.join(temp, mode, 'home');
  const desktop = path.join(home, 'Desktop');
  const destination = path.join(desktop, 'DataBrain');
  const selectionFile = path.join(temp, `${mode}-selection.json`);
  await fs.mkdir(desktop, { recursive: true });
  const env = {
    ...process.env,
    HOME: home,
    PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
    DATABRAIN_TEST_HOME: destination,
    DATABRAIN_TEST_SELECTION_FILE: selectionFile,
  };
  let client;
  if (mode === 'codex') {
    await fs.writeFile(selectionFile, JSON.stringify({ selections: { sources: [corpus], 'destination-parent': [desktop] }, approved: true }));
    client = startServer(launcher, [], env, mode);
  } else {
    await fs.writeFile(selectionFile, `${desktop}\n`);
    client = startServer(process.execPath, [path.join(repo, 'setup/mcp/server.mjs')], {
      ...env,
      DATABRAIN_ENGINE_DIR: resources,
    }, mode);
  }
  try {
    await client.request('initialize', {
      protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: `parity-${mode}`, version: '1' },
    });
    client.server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await client.call('databrain_setup_start');
    if (mode === 'codex') {
      await waitFor(client, status => status.includes('Stage: taxonomy pending.') && status.includes('Indexed rows: 5.'), `${mode} initial indexing`);
    } else {
      await waitFor(client, status => status.includes('Stage: destination ready.'), `${mode} destination chooser`);
      await fs.writeFile(selectionFile, `${corpus}\n`);
      await client.call('databrain_select_sources');
      await waitFor(client, status => status.includes('Stage: sources selected.'), `${mode} source chooser`);
      await client.call('databrain_setup_run');
      await waitFor(client, status => status.includes('Stage: taxonomy pending.') && status.includes('Indexed rows: 5.'), `${mode} initial indexing`);
    }
    const proposals = await client.call('databrain_taxonomy_candidates');
    const ids = taxonomyMap(proposals);
    assert.deepEqual([...ids.keys()].sort(), ['Projects', 'Research'], `${mode} taxonomy candidates: ${proposals}`);
    await client.call('databrain_apply_taxonomy', { assignments: [
      { folder_id: ids.get('Projects'), categories: ['projects'] },
      { folder_id: ids.get('Research'), categories: ['research'] },
    ] });
    await waitFor(client, status => status.includes('Stage: relationships pending.'), `${mode} taxonomy application`);
    await client.call('databrain_build_relationships');
    await waitFor(client, status => status.includes('Stage: verification pending.'), `${mode} relationship build`);
    return { ...client, home, destination, proposals };
  } catch (error) {
    client.server.kill('SIGTERM');
    throw error;
  }
}

const clients = [];
try {
  terminal('build-index.sh');
  terminal('ingest-root.sh', [corpus]);
  terminal('extract.sh');
  terminal('rebuild.sh');
  terminal('build-fts.sh');
  terminal('inventory.sh');
  const terminalProposals = terminal('taxonomy.sh', ['propose']);
  const terminalFolderAssignments = [`${projects}=projects`, `${research}=research`];
  terminal('taxonomy.sh', ['apply', ...terminalFolderAssignments]);
  terminal('rebuild.sh');
  terminal('build-fts.sh');
  terminal('relationships.sh');

  clients.push(await runMcpMode('claude'));
  clients.push(await runMcpMode('codex'));
  for (const client of clients) {
    assert.equal(client.proposals.trimEnd(), terminalProposals.trimEnd(), 'Terminal, Claude, and Codex taxonomy proposals must match exactly');
    const moc = path.join(client.destination, 'moc');
    for (const file of ['index.tsv', 'inventory.tsv', 'extract-report.tsv', 'relationships.tsv']) {
      const expected = await fs.readFile(path.join(terminalMoc, file), 'utf8');
      const actual = await fs.readFile(path.join(moc, file), 'utf8');
      assert.equal(normalizeGenerated(actual), normalizeGenerated(expected), `${file} differs between terminal and ${client === clients[0] ? 'Claude' : 'Codex'}`);
    }
  }

  const query = 'launch forecast delivery owner';
  const baselineSearch = terminal('fts.sh', [query, '10']);
  const baselinePaths = rankedPaths(baselineSearch);
  assert(baselinePaths.length > 0, `Terminal known query returned no results: ${baselineSearch}`);
  for (const client of clients) {
    const search = await client.call('databrain_search', { query, limit: 10 });
    const hits = rankedTokens(search);
    assert.deepEqual(hits.map(normalizeHit), baselinePaths, 'Terminal, Claude, and Codex ranked paths must match exactly');
    const hit = hits[0];
    const excerpt = await client.call('databrain_read', { path: hit });
    assert.match(excerpt, /twelve workdays/i, `${hit} must return the same source evidence`);
    const absent = await client.call('databrain_abstain_check', { queries: ['quartz telescope migration', 'violet meteorology ledger'] });
    assert.match(absent, /DRY — none of these query variants returned approved-source candidates/);
    assert.match(terminal('abstain-check.sh', ['quartz telescope migration', 'violet meteorology ledger']), /DRY/i);
    const health = await client.call('databrain_health');
    assert.match(health, /Source freshness: current\./);
    assert.match(health, /Ranked search database: \d+ rows; quick_check ok/);
  }

  const followup = path.join(projects, 'post-refresh-followup.md');
  await fs.writeFile(followup, '# Post-refresh follow-up\n\nThe handoff recovery checklist names the warehouse fallback owner.\n');
  const postRefreshFiles = [...files, followup];
  const postRefreshSnapshots = await Promise.all(postRefreshFiles.map(file => fs.readFile(file)));
  terminal('ingest-root.sh', [corpus]);
  terminal('extract.sh');
  terminal('taxonomy.sh', ['apply', `${projects}=projects`]);
  terminal('rebuild.sh');
  terminal('build-fts.sh');
  terminal('inventory.sh');
  terminal('relationships.sh');
  for (const client of clients) {
    const stale = await client.call('databrain_health');
    assert.match(stale, /Source freshness: stale: 1 added/);
    await client.call('databrain_refresh');
    await waitFor(client, status => status.includes('Stage: taxonomy pending.') && status.includes('Indexed rows: 6.'), 'post-change refresh');
    const refreshedCandidates = taxonomyMap(await client.call('databrain_taxonomy_candidates'));
    await client.call('databrain_apply_taxonomy', { assignments: [
      { folder_id: refreshedCandidates.get('Projects'), categories: ['projects'] },
    ] });
    await waitFor(client, status => status.includes('Stage: relationships pending.'), 'post-refresh taxonomy');
    await client.call('databrain_build_relationships');
    await waitFor(client, status => status.includes('Stage: verification pending.'), 'post-refresh relationships');
    const result = await client.call('databrain_search', { query: 'handoff recovery warehouse fallback', limit: 10 });
    assert(rankedPaths(result).includes(path.relative(corpus, followup)), 'refreshed index must surface the newly added file');
    assert.match(await client.call('databrain_health'), /Source freshness: current\./);
  }
  for (const client of clients) {
    const moc = path.join(client.destination, 'moc');
    for (const file of ['index.tsv', 'inventory.tsv', 'extract-report.tsv', 'relationships.tsv']) {
      const expected = await fs.readFile(path.join(terminalMoc, file), 'utf8');
      const actual = await fs.readFile(path.join(moc, file), 'utf8');
      assert.equal(normalizeGenerated(actual), normalizeGenerated(expected), `post-refresh ${file} differs between terminal and ${client === clients[0] ? 'Claude' : 'Codex'}`);
    }
  }

  assert.deepEqual(await Promise.all(postRefreshFiles.map(file => fs.readFile(file))), postRefreshSnapshots, 'all source originals remain byte-identical after refresh');
  process.stdout.write('PASS: the same Unicode-path fixture matches terminal, Claude-mode MCP, and packaged Codex mode for taxonomy, indexed metadata, extraction, relationships, ranking, reads, abstention, and freshness.\n');
  process.stdout.write('PASS: all three routes detect one added source as stale, refresh it, and return to matching current indexes without changing originals.\n');
  process.stdout.write('Scope: fixed local mechanics only; no model-generated answers, citations, or physical ChatGPT app behavior are tested.\n');
} finally {
  for (const client of clients) {
    client.server.kill('SIGTERM');
    if (client.server.exitCode === null) await new Promise(resolve => client.server.once('exit', resolve));
  }
  await fs.rm(temp, { recursive: true, force: true });
}
