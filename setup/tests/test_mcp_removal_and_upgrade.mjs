// 1) Removing a folder in settings leaves no text or file name from it anywhere in the DataBrain folder.
// 2) Files a refresh holds back as private are announced once, on the next status or search reply.
// 3) Upgrading from an older version never leaves anyone stuck: an existing valid brain is kept, otherwise ~/DataBrain (N) is used and said.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-removal-upgrade-')));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }

async function session(home, roots, run) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  let n = 0;
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
  try { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); await run(tool); }
  finally { child.kill('SIGTERM'); }
}
const grepAll = (needle, dir) => spawnSync('/usr/bin/grep', ['-rlaF', needle, dir], { encoding: 'utf8' }).stdout.trim();

try {
  // ---- 1 and 2: removal leaves nothing; new held files are announced once
  const home = path.join(temp, 'home');
  const alpha = path.join(home, 'AlphaFolderUnique');
  const beta = path.join(home, 'Beta');
  await fs.mkdir(alpha, { recursive: true }); await fs.mkdir(beta, { recursive: true });
  const [canonicalAlpha, canonicalBeta] = [await fs.realpath(alpha), await fs.realpath(beta)];
  await fs.writeFile(path.join(canonicalAlpha, 'alpha-note.md'), '# Alpha\nalphatextmarker only in the removed folder.\n');
  await fs.writeFile(path.join(canonicalAlpha, 'alpha-letter.rtf'), '{\\rtf1\\ansi alphartfmarker text from a converted file}');
  await fs.writeFile(path.join(canonicalAlpha, 'bank statement march.md'), '# Statement\nalphabankmarker\n');
  await fs.writeFile(path.join(canonicalBeta, 'beta-note.md'), '# Beta\nbetatextmarker stays.\n');
  const dataHome = path.join(home, 'DataBrain');

  await session(home, [canonicalAlpha, canonicalBeta], async tool => {
    await tool('databrain_setup_start');
    await until(async () => (await tool('databrain_setup_status')).startsWith('SETUP PAUSED FOR PRIVACY REVIEW'), 'privacy pause');
    await tool('databrain_privacy', { action: 'list' });
    await tool('databrain_privacy', { action: 'decide', keep: [] });
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished by itself');
    for (const marker of ['alphatextmarker', 'alphartfmarker', 'betatextmarker']) assert(grepAll(marker, dataHome) !== '', `${marker} should be present before removal`);
    assert(grepAll('bank statement march', dataHome) !== '', 'the held file name is recorded before removal');
  });
  await session(home, [canonicalBeta], async tool => {
    await tool('databrain_setup_status');   // applies the new folder list
    await until(async () => grepAll('alphatextmarker', dataHome) === '' && grepAll('alpha-note.md', dataHome) === '', 'removed folder text gone');
    await until(async () => (await tool('databrain_setup_status')).includes('Selected source folders: 1'), 'one folder selected');
    for (const leftover of ['alphatextmarker', 'alphartfmarker', 'alphabankmarker', 'alpha-note.md', 'alpha-letter.rtf', 'bank statement march', 'AlphaFolderUnique']) {
      assert.equal(grepAll(leftover, dataHome), '', `"${leftover}" from the removed folder must not remain anywhere in the DataBrain folder: ${grepAll(leftover, dataHome)}`);
    }
    assert(grepAll('betatextmarker', dataHome) !== '', 'the remaining folder stays indexed');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'removed-source indexing settled');
  });

  // new private-looking file in a kept folder, then a refresh: announced once
  await fs.writeFile(path.join(canonicalBeta, 'payslip-july.md'), '# Pay\nlatehelddmarker\n');
  await fs.writeFile(path.join(canonicalBeta, 'harmless-new.md'), '# New\nnewharmlessmarker\n');
  await session(home, [canonicalBeta], async rawTool => {
    const announcements = [];
    const tool = async (...args) => { const text = await rawTool(...args); const hit = /Held back for privacy: \d+ file\(s\) waiting for the user's decision \(\d+ of them newly held since the last notice\)\./.exec(text); if (hit) announcements.push(hit[0]); return text; };
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'stage settled');
    await tool('databrain_refresh');
    await until(async () => (await fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8')).includes('harmless-new.md'), 'refresh indexed the harmless file');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))) || null, 'refresh settled');
    await tool('databrain_search', { query: 'newharmlessmarker' });
    await tool('databrain_setup_status');
    assert.deepEqual(announcements, ["Held back for privacy: 1 file(s) waiting for the user's decision (1 of them newly held since the last notice)."], `the held file must be announced exactly once across all replies: ${JSON.stringify(announcements)}`);
    assert(grepAll('latehelddmarker', dataHome) === '', 'the held file text must not be indexed');
    const listed = await tool('databrain_privacy', { action: 'list' });
    assert(/payslip-july\.md/.test(listed), listed);
    assert(!/newly held since the last notice/.test(await tool('databrain_setup_status')), 'no repeat after the list was shown');
  });

  // ---- 3: upgrade paths
  const brainState = (parent, roots = []) => JSON.stringify({ stage: 'ready', destinationParent: parent, roots, rootIdentities: [], createdAt: new Date().toISOString() });
  async function scenario(name, prepare, rootsOf, check) {
    const h = path.join(temp, name);
    await fs.mkdir(h, { recursive: true });
    const real = await fs.realpath(h);
    const notes = path.join(real, 'Notes');
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(path.join(notes, 'upgrade.md'), '# Upgrade\nupgrademarker note.\n');
    await prepare(real, notes);
    await session(real, rootsOf(real, notes), async tool => check(real, tool, notes));
  }
  // saved location kept: the old brain on the Desktop is found without the old settings file
  await scenario('upgrade-found', async real => {
    const dir = path.join(real, 'Desktop', 'DataBrain', '.databrain');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'desktop-state.json'), brainState(path.join(real, 'Desktop')));
  }, (real, notes) => [notes], async (real, tool) => {
    const status = await tool('databrain_setup_status');
    assert(/DataBrain folder: ~\/Desktop\/DataBrain/.test(status) && /Stage: (ready|indexing|taxonomy pending|verification pending)/.test(status), `the existing brain must be kept: ${status.slice(0, 400)}`);
    await assert.rejects(fs.stat(path.join(real, 'DataBrain')), { code: 'ENOENT' }, 'no new brain next to a valid old one');
  });
  // an old brain that cannot be read: left alone, a new one is made in ~/DataBrain and chat is told
  await scenario('upgrade-corrupt', async real => {
    const dir = path.join(real, 'Desktop', 'DataBrain', '.databrain');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'desktop-state.json'), '{not json');
  }, (real, notes) => [notes], async (real, tool) => {
    const before = await tool('databrain_setup_status');
    assert(/state file this extension did not make or cannot read, so it was left untouched/.test(before) && !/unreadable/.test(before), `status must say so: ${before.slice(0, 500)}`);
    await tool('databrain_setup_start');
    await until(async () => (await fs.stat(path.join(real, 'DataBrain', 'moc', 'index.tsv')).catch(() => null)) || null, 'a new brain in ~/DataBrain');
    assert.equal(await fs.readFile(path.join(real, 'Desktop', 'DataBrain', '.databrain', 'desktop-state.json'), 'utf8'), '{not json', 'the old state is untouched');
  });
  // an old brain that sits inside a folder the user now asks to read: left alone, a new one is made, chat is told
  await scenario('upgrade-overlap', async real => {
    const dir = path.join(real, 'Desktop', 'DataBrain', '.databrain');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'desktop-state.json'), brainState(path.join(real, 'Desktop')));
    await fs.writeFile(path.join(real, 'Desktop', 'desk.md'), '# Desk\nupgradedeskmarker\n');
  }, real => [path.join(real, 'Desktop')], async (real, tool) => {
    const before = await tool('databrain_setup_status');
    assert(/sits inside, or contains, a folder you asked DataBrain to read/.test(before), `status must explain: ${before.slice(0, 500)}`);
    await tool('databrain_setup_start');
    await until(async () => (await fs.stat(path.join(real, 'DataBrain', 'moc', 'index.tsv')).catch(() => null)) || null, 'a new brain in ~/DataBrain');
    assert(!/stuck|settings changed/i.test(await tool('databrain_setup_status')));
  });
  // foreign brains are never adopted, refreshed, pruned or written into: a personal brain on the Desktop, an older bundle in the home folder,
  // and a look-alike state file that this extension did not write
  const { createHash } = await import('node:crypto');
  async function treeHash(dir) {
    const lines = [];
    const walk = async current => { for (const entry of (await fs.readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { lines.push(`d ${path.relative(dir, full)}`); await walk(full); }
      else lines.push(`f ${path.relative(dir, full)} ${createHash('sha256').update(await fs.readFile(full)).digest('hex')}`);
    } };
    await walk(dir);
    return lines.join('\n');
  }
  await scenario('foreign-brains', async real => {
    for (const dir of [path.join(real, 'Desktop', 'Databrain'), path.join(real, 'Databrain')]) {
      await fs.mkdir(path.join(dir, 'moc', 'extracted'), { recursive: true });
      await fs.mkdir(path.join(dir, 'bin'), { recursive: true });
      await fs.writeFile(path.join(dir, 'moc', 'index.tsv'), '# canonical_path\ttitle\tthemes\tkeywords\n~/elsewhere/a.md\tA\tmisc\t-\n');
      await fs.writeFile(path.join(dir, 'moc', 'fts.db'), 'foreign database bytes');
      await fs.writeFile(path.join(dir, 'INBOX.md'), 'foreign inbox\n');
    }
    const lookalike = path.join(real, 'Documents', 'DataBrain', '.databrain');
    await fs.mkdir(lookalike, { recursive: true });
    await fs.writeFile(path.join(lookalike, 'desktop-state.json'), JSON.stringify({ stage: 'ready', destinationParent: '/somewhere/else', roots: ['/x'] }));
  }, (real, notes) => [notes], async (real, tool, notes) => {
    const foreign = [path.join(real, 'Desktop', 'Databrain'), path.join(real, 'Databrain'), path.join(real, 'Documents', 'DataBrain')];
    const before = await Promise.all(foreign.map(treeHash));
    const status = await tool('databrain_setup_status');
    assert(/look-alike|did not make or cannot read/.test(status) || /DataBrain folder: ~\/DataBrain \d/.test(status), `status must show it will use its own folder: ${status.slice(0, 500)}`);
    await tool('databrain_setup_start');
    await until(async () => (await fs.stat(path.join(real, 'DataBrain 2', '.databrain', 'desktop-state.json')).catch(() => null)) || null, 'a new brain of its own');
    await until(async () => /Stage: (?:verification pending|ready)\./.test((await tool('databrain_setup_status'))), 'setup finished');
    // then every kind of write the extension can do: refresh, and a folder added in settings
    await fs.writeFile(path.join(notes, 'later.md'), '# Later\nforeignguardmarker\n');
    await tool('databrain_refresh');
    await until(async () => (await fs.readFile(path.join(real, 'DataBrain 2', 'moc', 'index.tsv'), 'utf8')).includes('later.md'), 'refresh ran in its own brain');
    const after = await Promise.all(foreign.map(treeHash));
    foreign.forEach((dir, index) => assert.equal(after[index], before[index], `${dir} must be byte-for-byte untouched`));
    assert.equal(await tool('databrain_search', { query: 'foreignguardmarker' }).then(text => /elsewhere\/a\.md/.test(text)), false, 'a foreign brain row must never appear in results');
  });
  console.log('PASS: removed folders leave nothing behind; new held files are announced once; upgrades keep a valid old brain or fall back to ~/DataBrain (N) and say so.');
} finally {
  await sleep(3000);   // let any background index step that was still finishing when its server was stopped end
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
