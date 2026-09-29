import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

const REPOSITORY = 'https://github.com/MelchiorLaTour/data-brain.git';
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const DIGEST = /^[0-9a-f]{64}$/;

function parseTsv(text, label) {
  const fields = new Map();
  for (const line of text.split('\n').filter(Boolean)) {
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error(`${label} contains a malformed field.`);
    const key = line.slice(0, separator);
    if (fields.has(key)) throw new Error(`${label} contains a duplicate field.`);
    fields.set(key, line.slice(separator + 1));
  }
  return Object.fromEntries(fields);
}

async function walkFiles(root, relative = '') {
  const files = [];
  for (const entry of await readdir(path.join(root, relative), { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (name === 'Resources/PAYLOAD.sha256' || name === '_CodeSignature' || name.endsWith('/_CodeSignature') ||
        name.includes('/_CodeSignature/') || name === 'CodeResources' || name.endsWith('/CodeResources')) continue;
    const absolute = path.join(root, name);
    if (entry.isSymbolicLink()) throw new Error(`The app bundle contains a symbolic link: ${name}.`);
    if (entry.isDirectory()) files.push(...await walkFiles(root, name));
    else if (entry.isFile()) files.push([name, absolute]);
    else throw new Error(`The app bundle contains an unsupported file: ${name}.`);
  }
  return files;
}

export async function readCodexPackageIdentity(contentsRoot) {
  const root = await realpath(contentsRoot);
  const resources = path.join(root, 'Resources');
  const packageInfo = parseTsv(await readFile(path.join(resources, 'PACKAGE.tsv'), 'utf8'), 'PACKAGE.tsv');
  const build = parseTsv(await readFile(path.join(resources, 'BUILDINFO.txt'), 'utf8'), 'BUILDINFO.txt');
  if (packageInfo.kind !== 'codex' || !VERSION.test(packageInfo.version || '') ||
      !['darwin-arm64', 'darwin-x64'].includes(packageInfo.architecture) ||
      !/^\d+\.\d+\.\d+$/.test(packageInfo.runtime_version || '') ||
      build.package_kind !== 'codex' || build.package_version !== packageInfo.version ||
      build.architecture !== packageInfo.architecture || build.runtime_version !== packageInfo.runtime_version ||
      build.engine_repository !== REPOSITORY || !/^[0-9a-f]{40}$/i.test(build.engine_revision || '') ||
      !DIGEST.test(build.source_sha256 || '')) {
    throw new Error('The Codex bundle identity or canonical build record is incomplete.');
  }

  const listed = new Map();
  const manifest = await readFile(path.join(resources, 'PAYLOAD.sha256'), 'utf8');
  for (const line of manifest.split('\n').filter(Boolean)) {
    const match = line.match(/^([0-9a-f]{64})  ([A-Za-z0-9._/-]+)$/);
    if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..') || listed.has(match[2])) {
      throw new Error('PAYLOAD.sha256 contains a malformed or duplicate entry.');
    }
    listed.set(match[2], match[1]);
  }
  const files = (await walkFiles(root)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (!listed.size || files.length !== listed.size || files.some(([relative]) => !listed.has(relative))) {
    throw new Error('PAYLOAD.sha256 does not cover the exact unsigned app payload.');
  }
  const sourceHash = createHash('sha256');
  for (const [relative, file] of files) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`The app payload file is unsafe: ${relative}.`);
    const digest = createHash('sha256').update(await readFile(file)).digest('hex');
    if (digest !== listed.get(relative)) throw new Error(`The app payload digest does not match: ${relative}.`);
    if (relative.startsWith('Resources/bin/') || relative.startsWith('Resources/setup/mcp/')) {
      sourceHash.update(`${digest}  ${relative}\n`);
    }
  }
  if (sourceHash.digest('hex') !== build.source_sha256) {
    throw new Error('The shipped DataBrain source payload does not match the build record digest.');
  }
  return { kind: 'codex', packageInfo, build, contentsRoot: root };
}
