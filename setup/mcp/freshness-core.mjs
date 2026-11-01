import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

function isSensitivePath(target) {
  const resolved = path.resolve(target);
  const normalized = resolved.split(path.sep).join('/');
  return normalized.endsWith('/Resources/Sensitive') || normalized.includes('/Resources/Sensitive/');
}

function assertNotSensitive(target) {
  if (isSensitivePath(target)) {
    throw new Error('Sensitive credential roots are not permitted.');
  }
}

function inside(file, root) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function decodeIndexPath(value, home = os.homedir()) {
  return value.startsWith('~') ? path.join(home, value.slice(1)) : value;
}

async function checkedRoots(roots) {
  if (!Array.isArray(roots) || !roots.length) throw new Error('At least one selected source root is required.');
  const result = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    assertNotSensitive(resolved);
    if (resolved !== root) throw new Error('Selected roots must be canonical absolute paths.');
    const info = await fs.lstat(resolved);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(resolved) !== resolved) {
      throw new Error('A selected root is unavailable or changed identity. Select it again.');
    }
    if (!result.includes(resolved)) result.push(resolved);
  }
  return result;
}

function parseIndex(indexText, roots, home) {
  const files = new Set();
  for (const line of indexText.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const stored = line.split('\t', 1)[0];
    const file = path.resolve(decodeIndexPath(stored, home));
    assertNotSensitive(file);
    if (roots.some(root => inside(file, root))) files.add(file);
  }
  return files;
}

function parseInventory(inventoryText, roots, home) {
  const files = new Set();
  for (const line of inventoryText.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [stored, status] = line.split('\t');
    if (!['eligible', 'indexed', 'missing_index'].includes(status)) continue;
    const file = path.resolve(decodeIndexPath(stored, home));
    assertNotSensitive(file);
    if (roots.some(root => inside(file, root))) files.add(file);
  }
  return files;
}

const excludedDirectories = new Set([
  'node_modules', '.git', '.obsidian', '.planning', '.venv', 'venv', '__pycache__',
  '.cache', 'Library', 'dist', 'build', '.claude', 'worktrees', '.ssh', '.gnupg', '.aws',
]);
const indexedExtensions = new Set(['.md', '.txt', '.pdf', '.docx', '.doc', '.pages', '.rtf']);

async function exists(file) { try { await fs.lstat(file); return true; } catch { return false; } }
// moc/ holding index.tsv or fts.db, or moc/, app-content/ or .databrain/ beside a .databrain/desktop-state.json (the mark of a DataBrain home).
async function isBrainGeneratedFolder(directory, name) {
  if (name === 'moc' && (await exists(path.join(directory, 'index.tsv')) || await exists(path.join(directory, 'fts.db')))) return true;
  return exists(path.join(path.dirname(directory), '.databrain', 'desktop-state.json'));
}

/** Enumerate names and file metadata under approved roots without opening document contents. */
export async function scanSelectedFiles({ roots }) {
  const approved = await checkedRoots(roots);
  const files = new Set();
  async function walk(directory, root) {
    assertNotSensitive(directory);
    if (await fs.realpath(directory) !== directory) throw new Error('A selected folder changed identity during freshness scanning.');
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (isSensitivePath(candidate)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (excludedDirectories.has(entry.name) || entry.name.endsWith('.app')) continue;
        if (['moc', 'app-content', '.databrain'].includes(entry.name) && await isBrainGeneratedFolder(candidate, entry.name)) continue;   // a DataBrain's generated folders are never indexed
        const pieces = path.relative(root, candidate).split(path.sep);
        if (pieces.some((piece, index) => piece === 'Resources' && pieces[index + 1] === 'Sensitive')) continue;
        if (pieces.some((piece, index) => piece === 'NewBrain' && pieces[index + 1] === 'research')) continue;
        if (path.basename(root) === 'NewBrain' && ['moc', 'bin', 'catalog'].includes(entry.name) && directory === root) continue;
        await walk(candidate, root);
      } else if (entry.isFile() && indexedExtensions.has(path.extname(entry.name).toLowerCase())) {
        files.add(candidate);
      }
    }
    if (await fs.realpath(directory) !== directory) throw new Error('A selected folder changed identity during freshness scanning.');
  }
  for (const root of approved) await walk(root, root);
  return [...files].sort();
}

async function sourceStat(file, roots) {
  assertNotSensitive(file);
  if (!roots.some(root => inside(file, root))) throw new Error('A freshness path is outside the selected roots.');
  try {
    const before = await fs.lstat(file, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || await fs.realpath(file) !== file) return null;
    const after = await fs.lstat(file, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) return null;
    return [before.dev, before.ino, before.size, before.mtimeNs, before.ctimeNs].map(String);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EPERM') return null;
    throw error;
  }
}

// A baseline row is dev, ino, size, mtime, ctime and (0.1.44) a sha256 of the bytes, '-' when there is none (cloud-only at the time, or the file moved while it was read).
// A file whose size and mtime match but whose ctime moved was only touched (cloud sync, a rewrite with the same bytes): it counts as changed only when its bytes differ.
async function contentDigest(file, roots, before) {
  try {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const after = await sourceStat(file, roots);
    return after && after.join('\t') === before.join('\t') ? hash.digest('hex') : null;
  } catch { return null; }
}

// A saved row starts with st_dev, which a reboot can change for the same disk. File identity is inode + size + mtime + ctime.
const sameStat = (saved, live) => saved.slice(1, 5).join('\t') === live.slice(1).join('\t');

const touchedOnly = (expected, actual) => {
  if (!actual || expected === 'missing') return false;
  const was = expected.split('\t');
  return !sameStat(was, actual) && was[2] === actual[2] && was[3] === actual[3];
};

// One call to datalessAmong answers for every touched file of a check (0.1.45): 0.1.44 asked once per file, a stat process each, which froze the whole server for about 9 s
// when a sync touched 6,000 files.
async function settleSame(items, roots, datalessAmong) {
  const touched = items.filter(({ expected, actual }) => touchedOnly(expected, actual));
  const cloudOnly = touched.length ? datalessAmong(touched.map(item => item.file)) : new Set();
  const result = new Map();
  for (const item of items) result.set(item.file, await sameSource(item.file, item.expected, item.actual, roots, cloudOnly));
  return result;
}

async function sameSource(file, expected, actual, roots, cloudOnly) {
  if (!actual || expected === 'missing') return false;
  const was = expected.split('\t');
  if (sameStat(was, actual)) return true;
  if (was[2] !== actual[2] || was[3] !== actual[3]) return false;
  if (cloudOnly.has(file)) return true;   // never opened: opening it would download it
  if (!was[5]) return false;     // a 0.1.43-format row has no digest column: the file cannot be proven the same, so it is changed once (the refresh records digests)
  if (was[5] === '-') return true;   // it was cloud-only (or unreadable) when the baseline was taken and is local now with its size and mtime kept: iCloud keeps the mtime on a download, a real edit moves it
  return (await contentDigest(file, roots, actual)) === was[5];
}

function encodePath(file) { return encodeURIComponent(file); }
function decodePath(file) {
  try { return decodeURIComponent(file); } catch { throw new Error('The freshness baseline is malformed.'); }
}

/** Capture metadata only; document bytes are never opened or read. */
export async function captureFreshnessBaseline({ roots, indexText, home = os.homedir(), previousText = '', datalessAmong = () => new Set() }) {
  const approved = await checkedRoots(roots);
  const indexed = parseIndex(indexText, approved, home);
  const previous = new Map();
  if (previousText.startsWith('# databrain-source-freshness-v1\n')) {
    for (const line of previousText.split('\n').slice(1)) {
      const [encoded, ...fields] = line.split('\t');
      try { if (encoded && fields.length > 5) previous.set(path.resolve(decodePath(encoded)), fields); } catch {}
    }
  }
  const entries = [];
  const needDigest = [];
  for (const file of [...indexed].sort()) {
    const metadata = await sourceStat(file, approved);
    const entry = { file, metadata, digest: '-' };
    const before = previous.get(file);
    if (metadata && before && sameStat(before, metadata) && before[5] !== '-') entry.digest = before[5];   // untouched since the last baseline: its digest still holds, nothing is read
    else if (metadata) needDigest.push(entry);
    entries.push(entry);
  }
  const cloudOnly = needDigest.length ? datalessAmong(needDigest.map(entry => entry.file)) : new Set();
  const toRead = needDigest.filter(entry => !cloudOnly.has(entry.file));
  for (let start = 0; start < toRead.length; start += 8) {
    await Promise.all(toRead.slice(start, start + 8).map(async entry => { entry.digest = await contentDigest(entry.file, approved, entry.metadata) ?? '-'; }));
  }
  const rows = entries.map(({ file, metadata, digest }) => `${encodePath(file)}\t${metadata ? [...metadata, digest].join('\t') : 'missing'}`);
  return `# databrain-source-freshness-v1\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

/** Compare an index and a freshly generated inventory against the saved metadata baseline. */
export async function checkFreshness({ roots, indexText, inventoryText, livePaths, baselineText, home = os.homedir(), datalessAmong = () => new Set() }) {
  const approved = await checkedRoots(roots);
  if (typeof baselineText !== 'string' || !baselineText.startsWith('# databrain-source-freshness-v1\n')) {
    throw new Error('No compatible freshness baseline exists; refresh DataBrain to establish one.');
  }
  const baseline = new Map();
  for (const line of baselineText.split('\n').slice(1)) {
    if (!line) continue;
    const [encoded, ...metadata] = line.split('\t');
    const file = path.resolve(decodePath(encoded));
    assertNotSensitive(file);
    if (baseline.has(file)) throw new Error('The freshness baseline contains an unsafe or duplicate path.');
    if (!approved.some(root => inside(file, root))) continue;
    baseline.set(file, metadata.join('\t'));
  }
  const indexed = parseIndex(indexText, approved, home);
  const live = Array.isArray(livePaths)
    ? new Set(livePaths.map(file => path.resolve(file)).filter(file => approved.some(root => inside(file, root))))
    : parseInventory(inventoryText || '', approved, home);
  const added = [...live].filter(file => !indexed.has(file)).sort();
  const deleted = [...indexed].filter(file => !live.has(file)).sort();
  const changed = [];
  const untracked = [];
  const compared = [];
  for (const file of indexed) {
    if (!live.has(file)) continue;
    const expected = baseline.get(file);
    if (expected === undefined) { untracked.push(file); continue; }
    compared.push({ file, expected, actual: await sourceStat(file, approved) });
  }
  const same = await settleSame(compared, approved, datalessAmong);
  for (const { file } of compared) if (!same.get(file)) changed.push(file);
  return { stale: Boolean(added.length || deleted.length || changed.length || untracked.length), added, deleted, changed: changed.sort(), untracked: untracked.sort() };
}

/**
 * Which of these indexed files were edited since the baseline was saved: one stat each, no contents opened.
 * -> Map file -> 'changed' | 'same' | 'unknown' (no usable baseline, or the file has no row in it).
 */
export async function changedSinceBaseline({ files, roots, baselineText, datalessAmong = () => new Set() }) {
  const approved = await checkedRoots(roots);
  const wanted = new Set(files.map(file => path.resolve(file)));
  const result = new Map();
  if (typeof baselineText !== 'string' || !baselineText.startsWith('# databrain-source-freshness-v1\n')) { for (const file of wanted) result.set(file, 'unknown'); return result; }
  const baseline = new Map();
  for (const line of baselineText.split('\n').slice(1)) {
    const tab = line.indexOf('\t');
    if (tab < 1) continue;
    let file; try { file = path.resolve(decodePath(line.slice(0, tab))); } catch { continue; }
    if (wanted.has(file)) baseline.set(file, line.slice(tab + 1));
  }
  const compared = [];
  for (const file of wanted) {
    const expected = baseline.get(file);
    if (expected === undefined) { result.set(file, 'unknown'); continue; }
    let actual = null;
    try { actual = await sourceStat(file, approved); } catch { result.set(file, 'unknown'); continue; }
    compared.push({ file, expected, actual });
  }
  const same = await settleSame(compared, approved, datalessAmong);
  for (const { file } of compared) result.set(file, same.get(file) ? 'same' : 'changed');
  return result;
}

/**
 * A file edited while a refresh was running may have been indexed before the edit, and a baseline
 * captured at the end records its post-edit state. Mark files modified inside [startedAt, finishedAt]
 * (ms since epoch) as "missing", so the next check reports them as changed and refreshes again.
 */
export async function flagChangedDuring({ baselineText, startedAt, finishedAt }) {
  let flagged = 0;
  const lines = await Promise.all(baselineText.split('\n').map(async line => {
    if (!line || line.startsWith('#')) return line;
    const encoded = line.split('\t', 1)[0];
    try {
      const info = await fs.lstat(decodePath(encoded));
      if (info.mtimeMs > startedAt && info.mtimeMs <= finishedAt) { flagged += 1; return `${encoded}\tmissing`; }
    } catch {}
    return line;
  }));
  return { text: lines.join('\n'), flagged };
}
