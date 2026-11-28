// Part 39. After a macOS update the Applications folder came back with a new inode, and every DataBrain tool failed with "An approved source
// folder changed identity" until the user ran repair. This test fakes that with invented folders in a fake HOME:
//   G1  a changed folder pauses only that folder: search finds a note in another folder, a capture into Downloads is saved, health and
//       status name only the paused folder.
//   G2  the app-check folder (the Applications folder, names only) heals by itself when it is a real folder, not a link, at the same real
//       path and owned by the system: no repair call, one log line `root-identity-refreshed <folder>`. G2b: the same folder swapped for a
//       link to a real folder must NOT heal.
//   G3  a user folder (Documents) that was replaced is refused, for that folder only, and never heals by itself.
//   G4  a disk-number (st_dev) change alone heals on this host too.
// Root ownership cannot be faked without sudo: "owned by the system" is one function in server.mjs whose expected owner a test can set
// with DATABRAIN_TEST_SYSTEM_FOLDER_UID (ignored on a real home folder). GATES=1,3 runs chosen gates. DATABRAIN_TEST_CLIENT=chatgpt|claude.
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = path.resolve(process.argv[2] || process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs'));
const chatgpt = (process.env.DATABRAIN_TEST_CLIENT || 'chatgpt') === 'chatgpt';
const gates = new Set((process.env.GATES || '1,2,3,4,5').split(',').map(Number));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-pause-')));
const readJson = file => fs.readFile(file, 'utf8').then(JSON.parse);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startServer(home, roots, extraEnv = {}) {
  const args = chatgpt ? ['--databrain-client', 'chatgpt'] : ['--databrain-parent', path.join(home, 'parent'), '--databrain-source-roots', ...roots];
  const server = spawn(process.execPath, [serverScript, ...args],
    { env: { ...process.env, HOME: home, ...extraEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  readline.createInterface({ input: server.stdout }).on('line', line => { try { const m = JSON.parse(line); replies.get(m.id)?.(m); } catch {} });
  let stderr = ''; server.stderr.setEncoding('utf8').on('data', c => { stderr += c; if (process.env.DBG) process.stderr.write(c); });
  let id = 0;
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method} ${stderr.slice(-400)}`)), 60000);
    replies.set(requestId, message => { clearTimeout(timer); replies.delete(requestId); resolve(message); });
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`);
  });
  const call = async (name, a = {}) => { const r = await request('tools/call', { name, arguments: a }); return r.result?.content?.[0]?.text ?? r.error?.message ?? JSON.stringify(r); };
  const stop = async () => { server.kill('SIGTERM'); if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve)); };
  return { call, stop, ready: async () => { await request('initialize', { protocolVersion: '2025-03-26' }); server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); } };
}

async function waitFor(call, tool, phrase) {
  let text = '';
  for (let i = 0; i < 600; i += 1) { text = await call(tool); if (text.includes(phrase)) return text; await sleep(50); }
  assert.fail(`Timed out waiting for ${phrase}: ${text}`);
}

// A fresh brain in its own fake HOME: Notes, Documents, Downloads and a fake Applications folder (the app-check root, names only).
async function freshBrain(label) {
  const home = path.join(temp, label);
  const dirs = { notes: path.join(home, 'Notes'), docs: path.join(home, 'Documents'), downloads: path.join(home, 'Downloads'), apps: path.join(home, 'SysApps') };
  for (const dir of Object.values(dirs)) await fs.mkdir(dir, { recursive: true });
  if (!chatgpt) await fs.mkdir(path.join(home, 'parent'));
  await fs.writeFile(path.join(dirs.notes, 'alpha.md'), '# Alpha\npausealphamarker kept note in the other folder\n');
  await fs.writeFile(path.join(dirs.docs, 'original.md'), '# Original\npauseoriginaldocmarker\n');
  await fs.writeFile(path.join(dirs.downloads, 'dl.md'), '# Download\npausedownloadmarker\n');
  const roots = [dirs.notes, dirs.docs, dirs.downloads, dirs.apps];
  const dataHome = chatgpt ? path.join(home, 'DataBrain') : path.join(home, 'parent', 'DataBrain');
  const env = { DATABRAIN_TEST_APP_DIRS: dirs.apps };
  const setup = startServer(home, roots, env);
  try {
    await setup.ready();
    const started = chatgpt ? await setup.call('databrain_setup_start', { folders: roots }) : await setup.call('databrain_setup_start');
    assert(started.includes('Creating DataBrain'), started);
    await waitFor(setup.call, 'databrain_setup_status', 'Stage: ready');   // both hosts index, label and verify by themselves
  } finally { await setup.stop(); }
  const statePath = path.join(dataHome, '.databrain', 'desktop-state.json');
  return { home, dirs, roots, env, dataHome, statePath, log: path.join(dataHome, '.databrain', 'stage-timing.log'),
    saved: async root => (await readJson(statePath)).rootIdentities.find(entry => entry.path === root) };
}
const tilde = (home, p) => p.replace(home, '~');
const replaceFolder = async dir => { await fs.rename(dir, `${dir}.old`); await fs.mkdir(dir); };

try {
  if (gates.has(1)) {
    const b = await freshBrain('g1');
    const savedApps = await b.saved(b.dirs.apps);
    await replaceFolder(b.dirs.apps);   // the macOS update: a new inode at the same path
    // Owner check says "not a system folder" here (expected owner uid 0, the test owns the folder): the folder stays paused.
    const s = startServer(b.home, b.roots, { ...b.env, DATABRAIN_TEST_SYSTEM_FOLDER_UID: '0' });
    try {
      await s.ready();
      const found = await s.call('databrain_search', { query: 'pausealphamarker' });
      assert(found.includes('alpha.md'), `G1: search must still find a note in another folder: ${found}`);
      assert(found.includes(tilde(b.home, b.dirs.apps)) && /paused/i.test(found), `G1: search must name the paused folder: ${found}`);
      const saved = await s.call('databrain_capture', { title: 'Pause capture', body: 'pausecapturemarker saved while a folder is paused', keywords: ['pause', 'capture'], folder: b.dirs.downloads });
      const written = (await fs.readdir(b.dirs.downloads)).filter(name => name !== 'dl.md');
      assert.equal(written.length, 1, `G1: the capture into Downloads must be saved: ${saved}`);
      const health = await s.call('databrain_health');
      assert(health.includes(tilde(b.home, b.dirs.apps)) && /paused/i.test(health), `G1: health must name the paused folder: ${health}`);
      for (const other of [b.dirs.notes, b.dirs.docs, b.dirs.downloads]) assert(!health.split('\n').some(line => /paused/i.test(line) && line.includes(`${tilde(b.home, other)}:`)), `G1: health must name only the paused folder: ${health}`);
      const status = await s.call('databrain_setup_status');
      assert(status.includes(tilde(b.home, b.dirs.apps)) && /paused/i.test(status), `G1: status must name the paused folder: ${status}`);
      if (chatgpt) { const list = await s.call('databrain_privacy_list'); assert(!/changed identity/.test(list), `G1: the privacy list must work: ${list}`); }
      assert.equal((await b.saved(b.dirs.apps)).ino, savedApps.ino, 'G1: a folder that is not a system folder must not heal by itself');
      assert(!(await fs.readFile(b.log, 'utf8').catch(() => '')).includes('root-identity-refreshed'), 'G1: no heal line');
    } finally { await s.stop(); }
    console.log('G1 PASS: one changed folder pauses only that folder (search, capture to Downloads, health, status work and name it).');
  }

  if (gates.has(2)) {
    const b = await freshBrain('g2');
    await replaceFolder(b.dirs.apps);
    const s = startServer(b.home, b.roots, { ...b.env, DATABRAIN_TEST_SYSTEM_FOLDER_UID: String(process.getuid()) });
    try {
      await s.ready();
      const found = await s.call('databrain_search', { query: 'pausealphamarker' });
      assert(found.includes('alpha.md') && !/paused/i.test(found), `G2: nothing is paused after the heal: ${found}`);
      const now = lstatSync(b.dirs.apps);
      const saved = await b.saved(b.dirs.apps);
      assert.deepEqual([saved.dev, saved.ino], [now.dev, now.ino], 'G2: the app-check folder identity must be re-recorded by itself');
      const tsv = await fs.readFile(path.join(b.dataHome, '.databrain', 'root-identities.tsv'), 'utf8');
      assert(tsv.includes(`${b.dirs.apps}\t${now.dev}:${now.ino}`), `G2: the identity grant file must match: ${tsv}`);
      const log = await fs.readFile(b.log, 'utf8');
      assert.equal(log.split('\n').filter(line => line.includes(`root-identity-refreshed ${b.dirs.apps}`)).length, 1, `G2: one log line: ${log.slice(-800)}`);
      const health = await s.call('databrain_health');
      assert(!/paused/i.test(health), `G2: health must not name a paused folder: ${health}`);
    } finally { await s.stop(); }
    // G2b: the same folder swapped for a link to a real folder must NOT heal.
    const c = await freshBrain('g2b');
    const before = await c.saved(c.dirs.apps);
    const target = path.join(c.home, 'elsewhere'); await fs.mkdir(target);
    await fs.rename(c.dirs.apps, `${c.dirs.apps}.old`); await fs.symlink(target, c.dirs.apps);
    const t = startServer(c.home, c.roots, { ...c.env, DATABRAIN_TEST_SYSTEM_FOLDER_UID: String(process.getuid()) });
    try {
      await t.ready();
      const found = await t.call('databrain_search', { query: 'pausealphamarker' });
      assert(found.includes('alpha.md'), `G2b: other folders still work: ${found}`);
      assert(/paused/i.test(found), `G2b: the linked folder stays paused: ${found}`);
      assert.equal((await c.saved(c.dirs.apps)).ino, before.ino, 'G2b: a link must not heal');
      assert(!(await fs.readFile(c.log, 'utf8').catch(() => '')).includes('root-identity-refreshed'), 'G2b: no heal line for a link');
    } finally { await t.stop(); }
    console.log('G2 PASS: the app-check folder heals by itself (no repair, one log line); a link in its place does not.');
  }

  if (gates.has(3)) {
    const b = await freshBrain('g3');
    const before = await b.saved(b.dirs.docs);
    await replaceFolder(b.dirs.docs);
    await fs.writeFile(path.join(b.dirs.docs, 'replacement.md'), '# R\npausereplacementsecret\n');
    const s = startServer(b.home, b.roots, { ...b.env, DATABRAIN_TEST_SYSTEM_FOLDER_UID: String(process.getuid()) });   // even "owned by the system" never heals a user folder
    try {
      await s.ready();
      const denied = await s.call('databrain_search', { query: 'pausereplacementsecret' });
      assert(!denied.includes('replacement.md') && denied.split('\n').filter(line => line.includes('pausereplacementsecret')).every(line => line.startsWith('no matches for:')),`G3: the replacement must not be searchable: ${denied}`);
      assert(denied.includes(tilde(b.home, b.dirs.docs)) && /paused/i.test(denied), `G3: the reply names the refused folder: ${denied}`);
      const other = await s.call('databrain_search', { query: 'pausealphamarker' });
      assert(other.includes('alpha.md'), `G3: other folders still work: ${other}`);
      const read = await s.call('databrain_read', { path: path.join(b.dirs.docs, 'original.md') });
      assert(!read.includes('pauseoriginaldocmarker'), `G3: nothing is read from the refused folder: ${read}`);
      assert(read.includes(tilde(b.home, b.dirs.docs)) && /paused/i.test(read), `G3: the read names the paused folder: ${read}`);
      assert.equal((await b.saved(b.dirs.docs)).ino, before.ino, 'G3: the saved record must stay bound to the original folder');
      assert(!(await fs.readFile(b.log, 'utf8').catch(() => '')).includes('root-identity-refreshed'), 'G3: a user folder never heals by itself');
    } finally { await s.stop(); }
    console.log('G3 PASS: a replaced user folder is refused for that folder only and does not heal by itself.');
  }

  if (gates.has(4)) {
    const b = await freshBrain('g4');
    const state = await readJson(b.statePath);
    state.rootIdentities = state.rootIdentities.map(entry => entry.path === b.dirs.notes ? { ...entry, dev: entry.dev + 2 } : entry);
    await fs.writeFile(b.statePath, `${JSON.stringify(state, null, 2)}\n`);
    const tsvPath = path.join(b.dataHome, '.databrain', 'root-identities.tsv');   // only the Notes line changes; the app-content line stays
    const stale = state.rootIdentities.find(entry => entry.path === b.dirs.notes);
    await fs.writeFile(tsvPath, (await fs.readFile(tsvPath, 'utf8')).split('\n').map(line => line.startsWith(`${b.dirs.notes}\t`) ? `${b.dirs.notes}\t${stale.dev}:${stale.ino}` : line).join('\n'));
    const s = startServer(b.home, b.roots, b.env);
    try {
      await s.ready();
      const found = await s.call('databrain_search', { query: 'pausealphamarker' });
      assert(found.includes('alpha.md') && !/paused/i.test(found), `G4: a disk-number change heals: ${found}`);
      assert.equal((await b.saved(b.dirs.notes)).dev, lstatSync(b.dirs.notes).dev, 'G4: the saved dev is refreshed');
    } finally { await s.stop(); }
    console.log(`G4 PASS: a disk-number change alone heals on the ${chatgpt ? 'ChatGPT' : 'Claude'} host.`);
  }

  // G5 (Part 39b): a paused folder stays approved through every grant-file write a normal call reaches while it is paused: add_sources of a
  // new folder (the reconciliation writes both grant files) and the indexing run after it (the app export rewrites the folder grant). Once the
  // original folder is back, it is approved and searchable again with no re-approval and no repair. Run for a paused Documents folder (G5a)
  // and for a paused Applications folder that does not heal (G5b).
  if (gates.has(5)) {
    for (const which of ['docs', 'apps']) {
      const label = which === 'docs' ? 'G5a' : 'G5b';
      const b = await freshBrain(`g5-${which}`);
      const folder = b.dirs[which];
      const before = await b.saved(folder);
      const extra = path.join(b.home, 'Extra');
      await fs.mkdir(extra);
      await fs.writeFile(path.join(extra, 'extra.md'), '# Extra\npauseextramarker added while a folder is paused\n');
      await fs.rename(folder, `${folder}.old`); await fs.mkdir(folder);   // paused: a new inode at the same path
      const env = { ...b.env, DATABRAIN_TEST_SYSTEM_FOLDER_UID: '0' };   // the app root must not heal here
      const grantHas = async root => (await fs.readFile(path.join(b.dataHome, '.source-roots'), 'utf8')).split('\n').includes(root)
        && (await fs.readFile(path.join(b.dataHome, '.databrain', 'root-identities.tsv'), 'utf8')).includes(`${root}\t${before.dev}:${before.ino}`);
      const s = startServer(b.home, [...b.roots, extra], env);
      try {
        await s.ready();
        if (chatgpt) {
          await s.call('databrain_add_sources', { folders: [extra] });
          const added = await s.call('databrain_add_sources', { folders: [extra], confirmed: true });
          assert(/Applying the folder list|Reconciliation job/.test(added), `${label}: add_sources: ${added}`);
        } else {
          await s.call('databrain_add_sources', { confirmed: true });
        }
        for (let i = 0; i < 600 && !(await readJson(b.statePath)).roots.includes(extra); i += 1) await sleep(50);
        const state = await readJson(b.statePath);
        assert(state.roots.includes(extra) && state.roots.includes(folder), `${label}: after add_sources both the new and the paused folder are approved: ${state.roots}`);
        assert(await grantHas(folder), `${label}: the grant files still list the paused folder with its original identity after add_sources`);
        await s.call('databrain_setup_run');   // the indexing run (app export rewrites the folder grant)
        await waitFor(s.call, 'databrain_setup_status', 'Stage: ready');
        const found = await s.call('databrain_search', { query: 'pauseextramarker' });
        assert(found.includes('extra.md'), `${label}: the new folder is searchable while the other is paused: ${found}`);
        assert(await grantHas(folder), `${label}: the grant files still list the paused folder after the indexing run`);
        assert.equal((await b.saved(folder)).ino, before.ino, `${label}: the paused folder keeps its original identity`);
      } finally { await s.stop(); }
      await fs.rm(folder, { recursive: true }); await fs.rename(`${folder}.old`, folder);   // the original folder is back
      const t = startServer(b.home, [...b.roots, extra], env);
      try {
        await t.ready();
        const status = await t.call('databrain_setup_status');
        assert(!/paused|waiting for the user's yes|changed identity|does not match/i.test(status), `${label}: no pause, no re-approval after the folder is back: ${status}`);
        if (which === 'docs') {
          await t.call('databrain_refresh');
          let found = '';
          for (let i = 0; i < 400 && !found.includes('original.md'); i += 1) { found = await t.call('databrain_search', { query: 'pauseoriginaldocmarker' }); if (!found.includes('original.md')) await sleep(100); }
          assert(found.includes('original.md') && !/paused/i.test(found), `${label}: the folder is searchable again: ${found}`);
        }
        const health = await t.call('databrain_health');
        assert(!/paused|changed identity|does not match/i.test(health), `${label}: health is clean after the folder is back: ${health}`);
      } finally { await t.stop(); }
      console.log(`${label} PASS: a paused ${which === 'docs' ? 'Documents' : 'Applications'} folder stays approved through add_sources and an indexing run, and is back with no re-approval.`);
    }
  }
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
