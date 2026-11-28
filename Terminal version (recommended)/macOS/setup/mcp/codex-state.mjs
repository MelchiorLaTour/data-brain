import { closeSync, constants as fsConstants, lstatSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync, fsyncSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const SCHEMA = 'databrain-codex-locator-v1';
export const CODEX_SETUP_MARKER = '.databrain-codex-setup-pending';
const CODEX_INDEX_TRANSACTION_MARKER = 'codex-index-transaction.tsv';

function validatePrivateTransactionTree(directory, root) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory ||
      !directory.startsWith(`${root}${path.sep}`)) return false;
  for (const entry of readdirSync(directory)) {
    const child = path.join(directory, entry);
    const childInfo = lstatSync(child);
    if (childInfo.isSymbolicLink() || (!childInfo.isDirectory() && !childInfo.isFile()) || realpathSync(child) !== child) return false;
    if (childInfo.isDirectory() && !validatePrivateTransactionTree(child, root)) return false;
  }
  return true;
}

function locatorPath(home = os.homedir()) {
  return path.join(home, 'Library', 'Application Support', 'DataBrain', 'Codex', 'connection.tsv');
}

function assertSafeDirectory(directory) {
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(directory) !== directory) {
    throw new Error('The private DataBrain connection folder is not a real local directory.');
  }
}

export function writeCodexSetupMarker(destination) {
  const info = lstatSync(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(destination) !== destination) {
    throw new Error('The pending DataBrain setup destination is not a canonical local directory.');
  }
  const marker = path.join(destination, CODEX_SETUP_MARKER);
  const temporary = `${marker}.${randomUUID()}.tmp`;
  const body = [
    'schema=databrain-codex-setup-pending-v1',
    `destination=${destination}`,
    `device=${info.dev}`,
    `inode=${info.ino}`,
    '',
  ].join('\n');
  const descriptor = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try { writeSync(descriptor, body); fsyncSync(descriptor); }
  catch (error) {
    closeSync(descriptor);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(descriptor);
  try { renameSync(temporary, marker); }
  catch (error) { unlinkSync(temporary); throw error; }
}

export async function inspectCodexSetupRecovery(destination) {
  const info = lstatSync(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(destination) !== destination) return { recoverable: false };
  const entries = await fs.readdir(destination);
  if (!entries.length) return { recoverable: true, needsMarker: true, staleTemps: [] };
  const staleTemps = [];
  const markerTemp = new RegExp(`^${CODEX_SETUP_MARKER.replaceAll('.', '\\.')}\\.[0-9a-f-]{36}\\.tmp$`);
  const rootsTemp = /^\.source-roots\.[0-9a-f-]{36}\.tmp$/;
  const allowedRoot = new Set([CODEX_SETUP_MARKER, '.databrain', '.source-roots']);
  for (const entry of entries) {
    if (allowedRoot.has(entry)) continue;
    if (markerTemp.test(entry) || rootsTemp.test(entry)) { staleTemps.push(path.join(destination, entry)); continue; }
    return { recoverable: false };
  }

  const marker = path.join(destination, CODEX_SETUP_MARKER);
  if (entries.includes(CODEX_SETUP_MARKER)) {
    const markerInfo = lstatSync(marker);
    const expectedMarker = [
      'schema=databrain-codex-setup-pending-v1',
      `destination=${destination}`,
      `device=${info.dev}`,
      `inode=${info.ino}`,
      '',
    ].join('\n');
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink() || (markerInfo.mode & 0o077) !== 0 ||
        await fs.readFile(marker, 'utf8') !== expectedMarker) return { recoverable: false };
  } else if (!staleTemps.some(file => path.basename(file).startsWith(`${CODEX_SETUP_MARKER}.`)) ||
      entries.some(entry => !markerTemp.test(entry))) {
    return { recoverable: false };
  }

  const rootsPath = path.join(destination, '.source-roots');
  if (entries.includes('.source-roots')) {
    const rootsInfo = lstatSync(rootsPath);
    if (!rootsInfo.isFile() || rootsInfo.isSymbolicLink()) return { recoverable: false };
  }
  const stateDir = path.join(destination, '.databrain');
  if (entries.includes('.databrain')) {
    const stateInfo = lstatSync(stateDir);
    if (!stateInfo.isDirectory() || stateInfo.isSymbolicLink() || realpathSync(stateDir) !== stateDir) return { recoverable: false };
    const stateEntries = await fs.readdir(stateDir);
    const allowedState = new Set([
      'desktop-state.json', 'root-identities.tsv', 'index-worker-lock.sqlite',
      'index-worker-lock.sqlite-journal', 'index-worker-lock.sqlite-wal', 'index-worker-lock.sqlite-shm',
      'codex-scope-commit-pending.tsv', CODEX_INDEX_TRANSACTION_MARKER,
    ]);
    const stateTemp = /^(desktop-state\.json|root-identities\.tsv|codex-scope-commit-pending\.tsv|codex-index-transaction\.tsv)\.[0-9a-f-]{36}\.tmp$/;
    const transactionDirectory = /^index-transaction-[0-9a-f-]{36}$/;
    let hasIndexMarker = false;
    for (const entry of stateEntries) {
      if (stateTemp.test(entry)) { staleTemps.push(path.join(stateDir, entry)); continue; }
      if (transactionDirectory.test(entry)) {
        if (!validatePrivateTransactionTree(path.join(stateDir, entry), stateDir)) return { recoverable: false };
        continue;
      }
      if (!allowedState.has(entry)) return { recoverable: false };
      if (entry === CODEX_INDEX_TRANSACTION_MARKER) hasIndexMarker = true;
    }
    if (stateEntries.some(entry => transactionDirectory.test(entry)) && !hasIndexMarker) return { recoverable: false };
    for (const entry of stateEntries) {
      if (stateTemp.test(entry) || transactionDirectory.test(entry)) continue;
      const file = path.join(stateDir, entry);
      const fileInfo = lstatSync(file);
      if (!fileInfo.isFile() || fileInfo.isSymbolicLink()) return { recoverable: false };
      if (entry.startsWith('index-worker-lock.sqlite') && (fileInfo.mode & 0o077) !== 0) return { recoverable: false };
      if (entry === 'codex-scope-commit-pending.tsv') {
        const expectedCommitMarker = [
          'schema=databrain-codex-scope-commit-v1',
          `destination=${destination}`,
          `device=${info.dev}`,
          `inode=${info.ino}`,
          '',
        ].join('\n');
        if ((fileInfo.mode & 0o077) !== 0 || await fs.readFile(file, 'utf8') !== expectedCommitMarker) return { recoverable: false };
      }
      if (entry === CODEX_INDEX_TRANSACTION_MARKER) {
        const rows = (await fs.readFile(file, 'utf8')).split('\n').filter(Boolean);
        const values = new Map(rows.map(row => {
          const separator = row.indexOf('=');
          return separator < 0 ? [row, ''] : [row.slice(0, separator), row.slice(separator + 1)];
        }));
        if ((fileInfo.mode & 0o077) !== 0 || values.size !== 8 ||
            values.get('schema') !== 'databrain-codex-index-transaction-v1' ||
            values.get('destination') !== destination || values.get('device') !== String(info.dev) ||
            values.get('inode') !== String(info.ino) || !/^[0-9a-f-]{36}$/.test(values.get('job') || '') ||
            !['building', 'prepared'].includes(values.get('phase')) ||
            (values.get('phase') === 'building' && values.get('stage') !== '-') ||
            (values.get('phase') === 'prepared' && !/^\d+:\d+$/.test(values.get('stage') || '')) ||
            (values.get('previous') !== '-' && !/^\d+:\d+$/.test(values.get('previous') || ''))) return { recoverable: false };
      }
    }
  }
  return { recoverable: true, needsMarker: !entries.includes(CODEX_SETUP_MARKER), staleTemps };
}

export async function removeCodexSetupMarker(destination) {
  await fs.unlink(path.join(destination, CODEX_SETUP_MARKER));
}

function parseLocator(text) {
  const rows = text.trimEnd().split('\n').map(line => line.split('\t'));
  if (rows.length !== 5 || rows.some(row => row.length !== 2)) throw new Error('The DataBrain connection record is malformed.');
  const values = new Map(rows);
  if (values.get('schema') !== SCHEMA || !values.has('destination') || !values.has('device') || !values.has('inode') || !values.has('generation')) {
    throw new Error('The DataBrain connection record uses an unsupported format.');
  }
  const destination = values.get('destination');
  const device = Number(values.get('device'));
  const inode = Number(values.get('inode'));
  const generation = Number(values.get('generation'));
  if (!path.isAbsolute(destination) || /[\r\n\t\0]/.test(destination) ||
      !Number.isSafeInteger(device) || device < 0 || !Number.isSafeInteger(inode) || inode < 1 ||
      !Number.isSafeInteger(generation) || generation < 0) {
    throw new Error('The DataBrain connection record contains invalid values.');
  }
  return { destination, device, inode, generation };
}

export function readCodexLocator({ home = os.homedir() } = {}) {
  const file = locatorPath(home);
  let info;
  try { info = lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing', path: file };
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) {
    throw new Error('The private DataBrain connection record is not a protected regular file.');
  }
  assertSafeDirectory(path.dirname(file));
  const locator = parseLocator(readFileSync(file, 'utf8'));
  let destinationInfo;
  try { destinationInfo = lstatSync(locator.destination); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'destination-missing', ...locator, path: file };
    throw error;
  }
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() ||
      destinationInfo.dev !== locator.device || destinationInfo.ino !== locator.inode ||
      realpathSync(locator.destination) !== locator.destination) {
    return { status: 'destination-identity-changed', ...locator, path: file };
  }
  return { status: 'connected', ...locator, path: file };
}

export async function writeCodexLocator({ home = os.homedir(), destination, generation = 0 }) {
  if (typeof destination !== 'string' || !path.isAbsolute(destination) || /[\r\n\t\0]/.test(destination)) {
    throw new Error('Choose one canonical DataBrain folder without tabs or line breaks.');
  }
  if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('The source approval generation is invalid.');
  const destinationInfo = lstatSync(destination);
  if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink() || realpathSync(destination) !== destination) {
    throw new Error('The approved DataBrain folder is no longer a canonical local directory.');
  }

  const file = locatorPath(home);
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let current = home;
  for (const part of path.relative(home, directory).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    assertSafeDirectory(current);
  }
  await fs.chmod(directory, 0o700);

  const body = [
    `schema\t${SCHEMA}`,
    `destination\t${destination}`,
    `device\t${destinationInfo.dev}`,
    `inode\t${destinationInfo.ino}`,
    `generation\t${generation}`,
    '',
  ].join('\n');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, body);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(temporary);
    throw error;
  }
  closeSync(fd);
  await fs.rename(temporary, file);
  await fs.chmod(file, 0o600);
  return file;
}
