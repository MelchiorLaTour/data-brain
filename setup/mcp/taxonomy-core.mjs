import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function decodeStoredPath(value) {
  return value.startsWith('~') ? path.join(os.homedir(), value.slice(1)) : value;
}

function normalizeAssignments(assignments, roots) {
  if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > 100) {
    throw new Error('Provide 1–100 confirmed folder assignments.');
  }
  const mapping = new Map();
  for (const assignment of assignments) {
    if (!assignment || typeof assignment.folder !== 'string' || !path.isAbsolute(assignment.folder)) {
      throw new Error('Each confirmed assignment needs an absolute folder path.');
    }
    const folder = path.resolve(assignment.folder);
    if (!roots.some(root => isInside(folder, root))) throw new Error('A confirmed folder is outside the selected source folders.');
    if (!Array.isArray(assignment.categories) || assignment.categories.length < 1 || assignment.categories.length > 5) {
      throw new Error('Each assigned folder needs 1–5 categories.');
    }
    const categories = [...new Set(assignment.categories)];
    if (categories.some(category => typeof category !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/.test(category))) {
      throw new Error('Categories must be short lowercase names using letters, numbers, hyphens, or underscores.');
    }
    if (mapping.has(folder)) throw new Error('Each folder may appear only once in confirmed assignments.');
    mapping.set(folder, categories);
  }
  return mapping;
}

export function applyConfirmedTaxonomy(indexText, roots, assignments) {
  const mapping = normalizeAssignments(assignments, roots);
  let changed = 0;
  const output = indexText.split('\n').map(line => {
    if (!line || line.startsWith('#')) return line;
    const columns = line.split('\t');
    if (columns.length < 4 || (columns[2] && columns[2] !== '-')) return line;
    let file;
    try { file = path.resolve(decodeStoredPath(columns[0])); } catch { return line; }
    if (!roots.some(root => isInside(file, root))) return line;
    const folder = [...mapping.keys()].filter(candidate => isInside(file, candidate)).sort((a, b) => b.length - a.length)[0];
    if (!folder) return line;
    columns[2] = mapping.get(folder).join(',');
    changed += 1;
    return columns.join('\t');
  }).join('\n');
  return { output, changed };
}

/**
 * Silent-refresh labels: give each unlabeled row the most common label set already used in its
 * top-level folder group (the same grouping as the candidates), or "unclassified" when the group
 * has no labels yet. Deterministic, so a background refresh never leaves unlabeled rows.
 */
export function inheritTaxonomy(indexText, roots) {
  const groupOf = file => {
    const root = roots.find(candidate => isInside(file, candidate));
    if (!root) return null;
    const first = path.relative(root, path.dirname(file)).split(path.sep).filter(Boolean)[0];
    return first ? path.join(root, first) : root;
  };
  const lines = indexText.split('\n');
  const parsed = lines.map(line => {
    if (!line || line.startsWith('#')) return null;
    const columns = line.split('\t');
    if (columns.length < 4) return null;
    let file;
    try { file = path.resolve(decodeStoredPath(columns[0])); } catch { return null; }
    const group = groupOf(file);
    if (!group) return null;
    return { columns, group, labeled: Boolean(columns[2]) && columns[2] !== '-' };
  });
  const tally = new Map();
  for (const row of parsed) {
    if (!row?.labeled) continue;
    const counts = tally.get(row.group) || new Map();
    counts.set(row.columns[2], (counts.get(row.columns[2]) || 0) + 1);
    tally.set(row.group, counts);
  }
  let changed = 0;
  const output = lines.map((line, index) => {
    const row = parsed[index];
    if (!row || row.labeled) return line;
    const counts = tally.get(row.group);
    row.columns[2] = counts
      ? [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0]
      : 'unclassified';
    changed += 1;
    return row.columns.join('\t');
  }).join('\n');
  return { output, changed };
}

export function proposeTaxonomyCandidates(indexText, roots) {
  const groups = new Map();
  for (const line of indexText.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [storedPath, title = '', themes = '-', keywords = '-'] = line.split('\t');
    if (!storedPath) continue;
    let file;
    try { file = path.resolve(decodeStoredPath(storedPath)); } catch { continue; }
    const root = roots.find(candidate => isInside(file, candidate));
    if (!root) continue;
    const relativeDir = path.relative(root, path.dirname(file));
    const first = relativeDir.split(path.sep).filter(Boolean)[0];
    const folder = first ? path.join(root, first) : root;
    const previous = groups.get(folder) || { count: 0, labels: new Set(), titles: new Set(), keywords: new Map() };
    previous.count += 1;
    if (title && previous.titles.size < 5) previous.titles.add(title);
    if (themes && themes !== '-') for (const label of themes.split(',')) previous.labels.add(label);
    if (keywords && keywords !== '-') for (const keyword of keywords.split(',')) previous.keywords.set(keyword, (previous.keywords.get(keyword) || 0) + 1);
    groups.set(folder, previous);
  }
  // Too many folders to label one by one: keep the largest, fold the rest into their source root,
  // so a root assignment still labels every file (a more specific kept folder wins on apply).
  const MAX_GROUPS = 40;
  if (groups.size > MAX_GROUPS) {
    const rootKeys = new Set(roots);
    const keep = new Set([...groups.entries()].filter(([folder]) => !rootKeys.has(folder))
      .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
      .slice(0, Math.max(0, MAX_GROUPS - roots.length)).map(([folder]) => folder));
    for (const [folder, info] of [...groups.entries()]) {
      if (rootKeys.has(folder) || keep.has(folder)) continue;
      const root = roots.filter(candidate => isInside(folder, candidate)).sort((a, b) => b.length - a.length)[0];
      const target = groups.get(root) || { count: 0, labels: new Set(), titles: new Set(), keywords: new Map() };
      target.count += info.count;
      for (const label of info.labels) target.labels.add(label);
      for (const title of info.titles) if (target.titles.size < 5) target.titles.add(title);
      for (const [keyword, count] of info.keywords) target.keywords.set(keyword, (target.keywords.get(keyword) || 0) + count);
      groups.set(root, target);
      groups.delete(folder);
    }
  }
  const rows = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([folderPath, info]) => {
    const id = `folder-${createHash('sha1').update(folderPath).digest('hex').slice(0, 12)}`;
    const owningRoot = roots.filter(candidate => isInside(folderPath, candidate)).sort((a, b) => b.length - a.length)[0];
    const relative = path.relative(owningRoot, folderPath);
    const folder = relative ? `${path.basename(owningRoot)} / ${relative}` : `${path.basename(owningRoot)} (selected folder)`;
    const keywords = [...info.keywords.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8).map(([keyword, count]) => `${keyword} (${count})`);
    return { id, folderPath, folder, files: info.count, existingLabels: [...info.labels].sort(), titles: [...info.titles], keywords };
  });
  if (!rows.length) throw new Error('No indexed folder groups are available for a category proposal.');
  const text = `Folder groups (file counts, up to five indexed titles, and frequent stored keywords; no document bodies read):\n${rows.map(row => `${row.id}\t${row.folder}\t${row.files} files\tcurrent labels: ${row.existingLabels.join(', ') || 'none'}\ttitles: ${row.titles.join(' | ') || 'none'}\tkeywords: ${row.keywords.join(', ') || 'none'}`).join('\n')}`;
  return { rows, text };
}

async function readApprovedIndex(indexPath, rootsPath) {
  const rootsInfo = await lstat(rootsPath);
  if (!rootsInfo.isFile() || rootsInfo.isSymbolicLink()) throw new Error('The selected-folder grant is not a regular local file.');
  const roots = (await readFile(rootsPath, 'utf8')).split('\n').filter(Boolean);
  if (!roots.length) throw new Error('The selected-folder grant is empty.');
  for (const root of roots) {
    if (/(?:^|\/)Resources\/Sensitive(?:\/|$)/.test(root)) throw new Error('Credential and sensitive roots are blocked.');
    const info = await lstat(root);
    if (!path.isAbsolute(root) || !info.isDirectory() || info.isSymbolicLink() || await realpath(root) !== root) {
      throw new Error('A selected source folder changed identity. Select it again.');
    }
  }
  const indexInfo = await lstat(indexPath);
  if (!indexInfo.isFile() || indexInfo.isSymbolicLink() || await realpath(indexPath) !== indexPath) {
    throw new Error('The generated index is not a regular canonical local file.');
  }
  return { roots, indexText: await readFile(indexPath, 'utf8') };
}

async function applyFile(indexPath, rootsPath, rawAssignments) {
  const { roots, indexText } = await readApprovedIndex(indexPath, rootsPath);
  const assignments = rawAssignments.map(value => {
    const separator = value.indexOf('=');
    if (separator < 1) throw new Error('Assignments must use folder=category,category format.');
    return { folder: value.slice(0, separator), categories: value.slice(separator + 1).split(',') };
  });
  const { output, changed } = applyConfirmedTaxonomy(indexText, roots, assignments);
  const tempPath = `${indexPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, output, { mode: 0o600, flag: 'wx' });
    await rename(tempPath, indexPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  process.stdout.write(`Applied confirmed categories to ${changed} previously unlabeled row(s). Existing labels and original files were left unchanged.\n`);
}

async function proposeFile(indexPath, rootsPath) {
  const { roots, indexText } = await readApprovedIndex(indexPath, rootsPath);
  process.stdout.write(`${proposeTaxonomyCandidates(indexText, roots).text}\n`);
}

const invokedPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => null) : null;
const modulePath = await realpath(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  const [command, indexPath, rootsPath, ...assignments] = process.argv.slice(2);
  if (!['apply', 'propose'].includes(command) || !indexPath || !rootsPath || (command === 'apply' && !assignments.length) || (command === 'propose' && assignments.length)) {
    console.error('usage: taxonomy-core.mjs propose INDEX.tsv ROOTS_FILE | apply INDEX.tsv ROOTS_FILE FOLDER=category[,category] ...');
    process.exitCode = 2;
  } else if (command === 'propose') {
    proposeFile(indexPath, rootsPath).catch(error => { console.error(`taxonomy: ${error.message}`); process.exitCode = 1; });
  } else {
    applyFile(indexPath, rootsPath, assignments).catch(error => { console.error(`taxonomy: ${error.message}`); process.exitCode = 1; });
  }
}
