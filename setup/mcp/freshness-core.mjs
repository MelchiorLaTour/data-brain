import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

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
  '.cache', 'Library', 'dist', 'build', '.claude', 'worktrees',
]);
const indexedExtensions = new Set(['.md', '.txt', '.pdf', '.docx', '.doc', '.pages', '.rtf']);

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

function encodePath(file) { return encodeURIComponent(file); }
function decodePath(file) {
  try { return decodeURIComponent(file); } catch { throw new Error('The freshness baseline is malformed.'); }
}

/** Capture metadata only; document bytes are never opened or read. */
export async function captureFreshnessBaseline({ roots, indexText, home = os.homedir() }) {
  const approved = await checkedRoots(roots);
  const indexed = parseIndex(indexText, approved, home);
  const rows = [];
  for (const file of [...indexed].sort()) {
    const metadata = await sourceStat(file, approved);
    rows.push(`${encodePath(file)}\t${metadata ? metadata.join('\t') : 'missing'}`);
  }
  return `# databrain-source-freshness-v1\n${rows.join('\n')}${rows.length ? '\n' : ''}`;
}

/** Compare an index and a freshly generated inventory against the saved metadata baseline. */
export async function checkFreshness({ roots, indexText, inventoryText, livePaths, baselineText, home = os.homedir() }) {
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
  for (const file of indexed) {
    if (!live.has(file)) continue;
    const expected = baseline.get(file);
    if (expected === undefined) { untracked.push(file); continue; }
    const actual = await sourceStat(file, approved);
    if (!actual || expected === 'missing' || expected !== actual.join('\t')) changed.push(file);
  }
  return { stale: Boolean(added.length || deleted.length || changed.length || untracked.length), added, deleted, changed: changed.sort(), untracked: untracked.sort() };
}
