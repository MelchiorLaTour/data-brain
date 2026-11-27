// Part 31 gate: the release check passes for the REAL build record of a clean ChatGPT build.
// Usage: node test_chatgpt_release_record.mjs <engine dir> <buildinfo.txt of the build>
// The release is fake: its three assets are the build's own file names; the commit API answers the build's revision.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [engine, buildinfoPath] = process.argv.slice(2);
const { checkGitHubRelease } = await import(pathToFileURL(path.join(engine, 'setup/mcp/github-release-check.mjs')));
const record = fs.readFileSync(buildinfoPath, 'utf8');
const parse = text => Object.fromEntries(text.split('\n').filter(Boolean).map(l => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const build = parse(record);
const version = build.package_version;
const tag = `v${version}`;
const stem = `DataBrain-ChatGPT-Installer-${version}`;
const names = [`${stem}.zip`, `${stem}.zip.sha256`, `${stem}.buildinfo.txt`];
const base = `https://github.com/MelchiorLaTour/data-brain/releases/download/${tag}/`;
const sha = build.engine_revision;

const fake = ({ published = record, assetNames = names, commit = sha } = {}) => async url => {
  if (url.endsWith(`/releases/tags/${tag}`)) return new Response(JSON.stringify({ tag_name: tag, draft: false, prerelease: true, assets: assetNames.map(name => ({ name, browser_download_url: base + name })) }));
  if (url.endsWith(`/commits/${sha}`)) return new Response(JSON.stringify({ sha: commit }));
  if (url.endsWith(`/git/ref/tags/${tag}`)) return new Response(JSON.stringify({ object: { sha, type: 'commit' } }));
  if (url === base + `${stem}.buildinfo.txt`) return new Response(published);
  return new Response('not found', { status: 404 });
};
const run = opts => checkGitHubRelease({ manifest: { version }, build, fetchImpl: fake(opts) });

assert.equal(build.package_kind, 'chatgpt');
assert.match(sha, /^[0-9a-f]{40}$/);
const ok = await run();
assert.equal(ok.state, 'PASS', ok.detail);
// Mutant gate: the same record marked dirty must FAIL.
const dirty = await run({ published: record.replace('source_tree=clean', 'source_tree=dirty') });
assert.equal(dirty.state, 'FAIL', 'dirty record must fail');
assert.match(dirty.detail, /clean source build|does not match/);
// Installed record dirty too (what the old zip had): published clean but installed dirty -> mismatch FAIL.
const installedDirty = await checkGitHubRelease({ manifest: { version }, build: { ...build, source_tree: 'dirty' }, fetchImpl: fake() });
assert.equal(installedDirty.state, 'FAIL');
// A commit the GitHub API does not know as this revision fails.
assert.equal((await run({ commit: 'c'.repeat(40) })).state, 'FAIL');
// A missing asset is BLOCKED, not PASS.
assert.equal((await run({ assetNames: names.slice(0, 2) })).state, 'BLOCKED');
console.log(`PASS release record: ${ok.detail}`);
