import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readCodexPackageIdentity } from '../mcp/package-identity.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'databrain-codex-identity-'));
const contents = path.join(root, 'DataBrain MCP.app', 'Contents');
const resources = path.join(contents, 'Resources');
const payloadPaths = [
  'Info.plist',
  'MacOS/databrain-mcp',
  'Frameworks/node/bin/node',
  'Resources/PACKAGE.tsv',
  'Resources/BUILDINFO.txt',
  'Resources/LICENSE',
  'Resources/runtime-LICENSE',
  'Resources/bin/search.sh',
  'Resources/setup/mcp/server.mjs',
];

async function writeRelative(relative, contentsText) {
  const file = path.join(contents, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contentsText, { mode: 0o600 });
}

function digest(text) { return createHash('sha256').update(text).digest('hex'); }
function manifestLine(file, hash) { return `${hash}  ${file}\n`; }

try {
  for (const file of payloadPaths) await writeRelative(file, `fixture:${file}\n`);
  await writeFile(path.join(resources, 'PACKAGE.tsv'), [
    'kind=codex',
    'version=0.1.0',
    'architecture=darwin-arm64',
    'runtime_version=24.21.0',
    'minimum_macos=14.0',
    '',
  ].join('\n'));
  const sourcePaths = payloadPaths.filter(file => file.startsWith('Resources/bin/') || file.startsWith('Resources/setup/mcp/')).sort();
  let sourceRecords = '';
  for (const file of sourcePaths) sourceRecords += manifestLine(file, digest(await readFile(path.join(contents, file))));
  const sourceDigest = digest(sourceRecords);
  await writeFile(path.join(resources, 'BUILDINFO.txt'), [
    'package_kind=codex',
    'package_version=0.1.0',
    'architecture=darwin-arm64',
    'runtime_version=24.21.0',
    'engine_repository=https://github.com/MelchiorLaTour/data-brain.git',
    `engine_revision=${'a'.repeat(40)}`,
    'source_tree=clean',
    `source_sha256=${sourceDigest}`,
    '',
  ].join('\n'));
  const allPaths = [...payloadPaths].sort();
  let payloadText = '';
  for (const file of allPaths) payloadText += manifestLine(file, digest(await readFile(path.join(contents, file))));
  await writeFile(path.join(resources, 'PAYLOAD.sha256'), payloadText);

  const identity = await readCodexPackageIdentity(contents);
  assert.equal(identity.kind, 'codex');
  assert.equal(identity.packageInfo.architecture, 'darwin-arm64');
  assert.equal(identity.build.runtime_version, '24.21.0');
  await writeFile(path.join(contents, 'Resources/setup/mcp/server.mjs'), 'tampered\n');
  await assert.rejects(() => readCodexPackageIdentity(contents), /digest does not match/);
  process.stdout.write('PASS: Codex identity validates version, architecture, runtime, source revision and exact app payload; a changed server file is rejected.\n');
} finally {
  await rm(root, { recursive: true, force: true });
}
