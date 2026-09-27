import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const engine = process.argv[2];
const { checkGitHubRelease } = await import(pathToFileURL(path.join(engine, 'setup/mcp/github-release-check.mjs')));
const manifest = { version: '0.1.0' };
const build = {
  engine_repository: 'https://github.com/MelchiorLaTour/data-brain.git',
  engine_revision: 'a'.repeat(40),
  source_tree: 'clean',
  source_sha256: 'b'.repeat(64),
};
const releaseUrl = 'https://github.com/MelchiorLaTour/data-brain/releases/download/v0.1.0/databrain.buildinfo.txt';
const assets = ['databrain.mcpb', 'databrain.mcpb.sha256', 'databrain.buildinfo.txt'].map(name => ({
  name,
  browser_download_url: `https://github.com/MelchiorLaTour/data-brain/releases/download/v0.1.0/${name}`,
}));
const info = Object.entries(build).map(([key, value]) => `${key}=${value}`).join('\n');

function mockFetch({ status = 200, tag = 'v0.1.0', record = info, assetUrl = releaseUrl, releaseAssets = assets, commitSha = build.engine_revision, taggedSha = build.engine_revision, tagObjectType = 'commit', tagDepth = 1, tagCycle = false, tagStatus = 200 } = {}) {
  return async url => {
    if (url.endsWith('/releases/latest')) {
      return new Response(JSON.stringify({ tag_name: tag, assets: releaseAssets.map(asset => asset.name === 'databrain.buildinfo.txt' ? { ...asset, browser_download_url: assetUrl } : asset) }), { status });
    }
    if (url.endsWith(`/commits/${build.engine_revision}`)) return new Response(JSON.stringify({ sha: commitSha }), { status });
    if (url.endsWith('/git/ref/tags/v0.1.0')) return new Response(JSON.stringify({ object: { sha: tagObjectType === 'tag' ? 'd'.repeat(40) : taggedSha, type: tagObjectType } }), { status: tagStatus });
    if (url.endsWith(`/git/tags/${'d'.repeat(40)}`)) return new Response(JSON.stringify({ object: tagCycle ? { sha: 'd'.repeat(40), type: 'tag' } : tagDepth > 1 ? { sha: 'e'.repeat(40), type: 'tag' } : { sha: taggedSha, type: 'commit' } }), { status });
    if (url.endsWith(`/git/tags/${'e'.repeat(40)}`)) return new Response(JSON.stringify({ object: { sha: taggedSha, type: 'commit' } }), { status });
    return new Response(record, { status });
  };
}

const pass = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch() });
assert.equal(pass.state, 'PASS');
const mismatch = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ record: info.replace(`engine_revision=${build.engine_revision}`, `engine_revision=${'c'.repeat(40)}`) }) });
assert.equal(mismatch.state, 'FAIL');
const absent = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ status: 404 }) });
assert.equal(absent.state, 'BLOCKED');
const missingPackageAsset = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ releaseAssets: assets.filter(asset => asset.name !== 'databrain.mcpb') }) });
assert.equal(missingPackageAsset.state, 'BLOCKED');
const missingCommit = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ commitSha: 'c'.repeat(40) }) });
assert.equal(missingCommit.state, 'FAIL');
const missingTag = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ tagStatus: 404 }) });
assert.equal(missingTag.state, 'FAIL');
const mismatchedTag = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ taggedSha: 'c'.repeat(40) }) });
assert.equal(mismatchedTag.state, 'FAIL');
const annotatedTag = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ tagObjectType: 'tag' }) });
assert.equal(annotatedTag.state, 'PASS');
const nestedAnnotatedTag = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ tagObjectType: 'tag', tagDepth: 2 }) });
assert.equal(nestedAnnotatedTag.state, 'PASS');
const cyclicAnnotatedTag = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ tagObjectType: 'tag', tagCycle: true }) });
assert.equal(cyclicAnnotatedTag.state, 'FAIL');
const oversizedAsset = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ record: 'x'.repeat(4097) }) });
assert.equal(oversizedAsset.state, 'FAIL');
const oversizedApi = await checkGitHubRelease({ manifest, build, fetchImpl: async () => new Response('x'.repeat(65537)) });
assert.equal(oversizedApi.state, 'FAIL');
const unsafe = await checkGitHubRelease({ manifest, build, fetchImpl: mockFetch({ assetUrl: 'https://example.invalid/buildinfo.txt' }) });
assert.equal(unsafe.state, 'FAIL');
const redirect = await checkGitHubRelease({
  manifest,
  build,
  fetchImpl: async url => {
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v0.1.0', assets: assets.map(asset => asset.name === 'databrain.buildinfo.txt' ? { ...asset, browser_download_url: releaseUrl } : asset) }));
    if (url.endsWith(`/commits/${build.engine_revision}`)) return new Response(JSON.stringify({ sha: build.engine_revision }));
    if (url.endsWith('/git/ref/tags/v0.1.0')) return new Response(JSON.stringify({ object: { sha: build.engine_revision, type: 'commit' } }));
    return new Response(null, { status: 302, headers: { location: 'https://example.invalid/redirected-buildinfo.txt' } });
  },
});
assert.equal(redirect.state, 'FAIL');
const allowedRedirect = await checkGitHubRelease({
  manifest,
  build,
  fetchImpl: async url => {
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify({ tag_name: 'v0.1.0', assets: assets.map(asset => asset.name === 'databrain.buildinfo.txt' ? { ...asset, browser_download_url: releaseUrl } : asset) }));
    if (url.endsWith(`/commits/${build.engine_revision}`)) return new Response(JSON.stringify({ sha: build.engine_revision }));
    if (url.endsWith('/git/ref/tags/v0.1.0')) return new Response(JSON.stringify({ object: { sha: build.engine_revision, type: 'commit' } }));
    if (url === releaseUrl) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/databrain.buildinfo.txt' } });
    assert.equal(url, 'https://release-assets.githubusercontent.com/databrain.buildinfo.txt');
    return new Response(info);
  },
});
assert.equal(allowedRedirect.state, 'PASS');
process.stdout.write('PASS: GitHub release audit checks required assets, a reachable source commit, and lightweight or bounded nested annotated release-tag identity; rejects cyclic tags; bounds responses, accepts exact metadata and approved redirects, detects mismatches, blocks a missing release, and rejects unexpected hosts and redirects.\n');
