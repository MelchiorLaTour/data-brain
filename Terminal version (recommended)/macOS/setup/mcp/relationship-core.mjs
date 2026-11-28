import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function markdownLinkTargets(line, sourcePath, wikiNames) {
  const targets = [];
  for (const match of line.matchAll(/\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+[^)]*)?\s*\)/g)) {
    let target = (match[1] || match[2] || '').replace(/\\([()\\])/g, '$1');
    if (!target || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(target)) continue;
    target = target.split('#', 1)[0].split('?', 1)[0];
    try { target = decodeURIComponent(target); } catch { continue; }
    if (target) targets.push(path.resolve(path.dirname(sourcePath), target));
  }
  if (wikiNames) for (const match of line.matchAll(/!?\[\[([^\]|#]+)[^\]]*\]\]/g)) {
    const file = wikiNames.get(path.basename(match[1].trim()).toLocaleLowerCase());
    if (file) targets.push(file);
  }
  return targets;
}

// Obsidian resolves [[Name]] by file name anywhere in the vault; ambiguous names are skipped.
export function wikiNameIndex(files) {
  const names = new Map();
  for (const file of files) {
    const base = path.basename(file).toLocaleLowerCase();
    for (const key of new Set([base, base.replace(/\.(?:md|markdown)$/, '')])) names.set(key, names.has(key) ? null : file);
  }
  return names;
}

export function finalizeRelationshipRecords(records) {
  const duplicateGroups = new Map();
  const titleGroups = new Map();
  const byPath = new Map(records.map(record => [record.file, record]));
  for (const record of records) {
    if (record.digest) duplicateGroups.set(record.digest, [...(duplicateGroups.get(record.digest) || []), record.file]);
    const normalizedTitle = record.title.trim().toLocaleLowerCase();
    if (normalizedTitle) titleGroups.set(normalizedTitle, [...(titleGroups.get(normalizedTitle) || []), record.file]);
  }
  for (const files of titleGroups.values()) if (files.length > 1) for (const file of files) byPath.get(file).sameTitle = true;
  const escape = value => encodeURIComponent(String(value)).replace(/%20/g, '+');
  const lines = ['# path\troom\ttitle\tkeywords\texplicit_markdown_links\texact_duplicate_group\tsame_title_conflict_review\tsource_status'];
  for (const record of [...records].sort((a, b) => a.file.localeCompare(b.file))) {
    const duplicates = duplicateGroups.get(record.digest) || [];
    const group = duplicates.length > 1 ? createHash('sha256').update([...duplicates].sort().join('\n')).digest('hex').slice(0, 16) : '-';
    lines.push([record.file, record.room, record.title, record.keywords, record.links.join('|') || '-', group, record.sameTitle ? 'review' : '-', record.sourceStatus].map(escape).join('\t'));
  }
  return {
    report: `${lines.join('\n')}\n`,
    links: records.reduce((count, item) => count + item.links.length, 0),
    duplicateGroups: [...duplicateGroups.values()].filter(files => files.length > 1).length,
    titleConflicts: [...titleGroups.values()].filter(files => files.length > 1).length,
    unavailable: records.filter(record => record.sourceStatus !== 'available').length,
  };
}

async function buildFromEnvironment() {
  const moc = process.env.NB_MOC_DIR;
  const grantFile = process.env.NB_CANON_ROOTS_FILE;
  if (!moc || !grantFile) throw new Error('Set NB_MOC_DIR and NB_CANON_ROOTS_FILE to the selected DataBrain index and folder grant.');
  const grantInfo = await fs.lstat(grantFile);
  if (!grantInfo.isFile() || grantInfo.isSymbolicLink()) throw new Error('The selected-folder grant is not a regular local file. Select source folders again.');
  const roots = (await fs.readFile(grantFile, 'utf8')).split('\n').filter(Boolean);
  if (!roots.length) throw new Error('The selected-folder grant is empty. Select source folders again.');
  const rootIdentities = new Map();
  for (const root of roots) {
    if (/(?:^|\/)Resources\/Sensitive(?:\/|$)/.test(root)) throw new Error('Credential and sensitive roots are blocked.');
    const info = await fs.lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink() || await fs.realpath(root) !== root) throw new Error('A selected source folder changed identity. Select it again.');
    rootIdentities.set(root, info);
  }
  const assertRootIdentity = async root => {
    const current = await fs.lstat(root);
    const expected = rootIdentities.get(root);
    if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== expected.dev || current.ino !== expected.ino || await fs.realpath(root) !== root) throw new Error('A selected source folder changed identity. Select it again.');
  };
  if (await fs.realpath(moc) !== moc) throw new Error('The DataBrain index folder is not canonical.');
  const indexPath = path.join(moc, 'index.tsv');
  const indexInfo = await fs.lstat(indexPath);
  if (!indexInfo.isFile() || indexInfo.isSymbolicLink()) throw new Error('The generated index is not a regular local file.');
  const index = await fs.readFile(indexPath, 'utf8');
  const records = [];
  const wikiNames = wikiNameIndex(index.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    let file = line.split('\t')[0];
    try { file = decodeURIComponent(file.replace(/\+/g, ' ')); } catch { return ''; }
    return file.startsWith('~/') ? path.join(os.homedir(), file.slice(2)) : file;
  }));
  for (const line of index.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const [storedPath, title = '', room = '-', keywords = '-'] = line.split('\t');
    let file;
    try { file = decodeURIComponent(storedPath.replace(/\+/g, ' ')); } catch { continue; }
    if (file.startsWith('~/')) file = path.join(os.homedir(), file.slice(2));
    const root = roots.find(candidate => file.startsWith(`${candidate}/`));
    if (!root) continue;
    const record = { file, title, room, keywords, links: [], digest: null, sameTitle: false, sourceStatus: 'available' };
    let handle;
    try {
      const before = await fs.lstat(file);
      if (before.isSymbolicLink()) record.sourceStatus = 'symbolic_link';
      else if (!before.isFile()) record.sourceStatus = 'not_regular_file';
      else if (await fs.realpath(file) !== file) record.sourceStatus = 'noncanonical_path';
      else {
        await assertRootIdentity(root);
        handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) throw new Error('Source identity changed while opening.');
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Source changed while being read.');
        await assertRootIdentity(root);
        record.digest = createHash('sha256').update(bytes).digest('hex');
        if (/\.(?:md|markdown)$/i.test(file)) {
          for (const text of bytes.toString('utf8').split('\n')) for (const target of markdownLinkTargets(text, file, wikiNames)) {
            if (!roots.some(approved => target.startsWith(`${approved}/`))) continue;
            try {
              await assertRootIdentity(roots.find(approved => target.startsWith(`${approved}/`)));
              const targetInfo = await fs.lstat(target);
              if (targetInfo.isFile() && !targetInfo.isSymbolicLink() && await fs.realpath(target) === target) record.links.push(target);
            } catch (error) { if (error.code !== 'ENOENT') throw error; }
          }
        }
      }
    } catch (error) {
      if (error.code === 'ENOENT') record.sourceStatus = 'missing';
      else if (['EACCES', 'EPERM'].includes(error.code)) record.sourceStatus = 'unreadable';
      else throw error;
    } finally { await handle?.close(); }
    record.links = [...new Set(record.links)].sort();
    records.push(record);
  }
  const summary = finalizeRelationshipRecords(records);
  const report = path.join(moc, 'relationships.tsv');
  const temp = `${report}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, summary.report, { mode: 0o600, flag: 'wx' });
  try { await fs.rename(temp, report); } catch (error) { await fs.unlink(temp).catch(() => {}); throw error; }
  process.stdout.write(`Relationship report saved for ${records.length} indexed rows. Explicit local Markdown links: ${summary.links}; exact duplicate groups: ${summary.duplicateGroups}; same-title groups for human review: ${summary.titleConflicts}; unavailable or unsafe sources: ${summary.unavailable}. Shared keywords were not treated as proof. Canonical files were not changed.\n`);
}

const invokedPath = process.argv[1] ? await fs.realpath(process.argv[1]).catch(() => null) : null;
const modulePath = await fs.realpath(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  buildFromEnvironment().catch(error => { process.stderr.write(`relationships: ${error.message}\n`); process.exitCode = 1; });
}
