const API_URL = 'https://api.github.com/repos/MelchiorLaTour/data-brain/releases/latest';
const COMMIT_API_ROOT = 'https://api.github.com/repos/MelchiorLaTour/data-brain/commits/';
const GIT_REF_API_ROOT = 'https://api.github.com/repos/MelchiorLaTour/data-brain/git/ref/tags/';
const TAG_API_ROOT = 'https://api.github.com/repos/MelchiorLaTour/data-brain/git/tags/';
const REPOSITORY = 'https://github.com/MelchiorLaTour/data-brain.git';
const RELEASE_ROOT = '/MelchiorLaTour/data-brain/releases/download/';

function parseBuildInfo(text) {
  const fields = Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
    const split = line.indexOf('=');
    return split < 0 ? [line, ''] : [line.slice(0, split), line.slice(split + 1)];
  }));
  return fields;
}

async function readBoundedText(response, limit) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    const error = new Error('GitHub release metadata exceeded the allowed size.');
    error.name = 'PayloadTooLargeError';
    throw error;
  }
  const reader = response.body?.getReader();
  if (!reader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) {
      const error = new Error('GitHub release metadata exceeded the allowed size.');
      error.name = 'PayloadTooLargeError';
      throw error;
    }
    return text;
  }
  const decoder = new TextDecoder();
  let length = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > limit) {
      await reader.cancel();
      const error = new Error('GitHub release metadata exceeded the allowed size.');
      error.name = 'PayloadTooLargeError';
      throw error;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export async function checkGitHubRelease({ manifest, build, fetchImpl = fetch, timeoutMs = 5000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(API_URL, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (response.status === 404) return { state: 'BLOCKED', detail: 'No published GitHub release is available to compare with this installation.' };
    if (!response.ok) return { state: 'BLOCKED', detail: `GitHub latest-release check returned HTTP ${response.status}.` };
    const release = JSON.parse(await readBoundedText(response, 65536));
    const expectedTag = `v${manifest.version}`;
    if (release.tag_name !== expectedTag || !Array.isArray(release.assets)) {
      return { state: 'FAIL', detail: `GitHub latest release ${String(release.tag_name || 'has no tag')} does not match installed version ${manifest.version}.` };
    }
    const requiredAssets = ['databrain.mcpb', 'databrain.mcpb.sha256', 'databrain.buildinfo.txt'];
    const missingAssets = requiredAssets.filter(name => !release.assets.some(item => item.name === name));
    if (missingAssets.length) {
      return { state: 'BLOCKED', detail: `The latest GitHub release is missing required asset(s): ${missingAssets.join(', ')}.` };
    }
    for (const name of requiredAssets) {
      const asset = release.assets.find(item => item.name === name);
      const expectedPath = `${RELEASE_ROOT}${encodeURIComponent(expectedTag)}/${encodeURIComponent(name)}`;
      if (typeof asset.browser_download_url !== 'string') {
        return { state: 'BLOCKED', detail: `The latest GitHub release has no download URL for ${name}.` };
      }
      const assetUrl = new URL(asset.browser_download_url);
      if (assetUrl.protocol !== 'https:' || assetUrl.hostname !== 'github.com' || assetUrl.pathname !== expectedPath) {
        return { state: 'FAIL', detail: `GitHub returned an unexpected release-asset URL for ${name}.` };
      }
    }
    const asset = release.assets.find(item => item.name === 'databrain.buildinfo.txt');
    const assetUrl = new URL(asset.browser_download_url);
    let recordResponse = await fetchImpl(assetUrl.href, { signal: controller.signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(recordResponse.status)) {
      const redirectUrl = new URL(recordResponse.headers.get('location') || '', assetUrl);
      if (redirectUrl.protocol !== 'https:' || redirectUrl.hostname !== 'release-assets.githubusercontent.com') {
        return { state: 'FAIL', detail: 'GitHub release record redirected to an unexpected host.' };
      }
      recordResponse = await fetchImpl(redirectUrl.href, { signal: controller.signal, redirect: 'error' });
    }
    if (!recordResponse.ok) return { state: 'BLOCKED', detail: `GitHub release build record returned HTTP ${recordResponse.status}.` };
    const recordText = await readBoundedText(recordResponse, 4096);
    const published = parseBuildInfo(recordText);
    const fields = ['engine_repository', 'engine_revision', 'source_tree', 'source_sha256'];
    const mismatch = fields.find(field => published[field] !== build[field]);
    if (published.engine_repository !== REPOSITORY) {
      return { state: 'FAIL', detail: 'GitHub release record names an unexpected source repository.' };
    }
    if (mismatch) return { state: 'FAIL', detail: `Installed ${mismatch} does not match the latest GitHub release record.` };
    if (published.source_tree !== 'clean') return { state: 'FAIL', detail: 'The latest GitHub release record is not marked as a clean source build.' };
    const commitResponse = await fetchImpl(`${COMMIT_API_ROOT}${encodeURIComponent(build.engine_revision)}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (commitResponse.status === 404) return { state: 'FAIL', detail: 'The release build record references a source revision that is not present in the GitHub repository.' };
    if (!commitResponse.ok) return { state: 'BLOCKED', detail: `GitHub source-revision check returned HTTP ${commitResponse.status}.` };
    const commit = JSON.parse(await readBoundedText(commitResponse, 65536));
    if (commit.sha !== build.engine_revision) return { state: 'FAIL', detail: 'The installed source revision does not match the commit returned by GitHub.' };
    const refResponse = await fetchImpl(`${GIT_REF_API_ROOT}${encodeURIComponent(expectedTag)}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      signal: controller.signal,
      redirect: 'error',
    });
    if (refResponse.status === 404) return { state: 'FAIL', detail: `GitHub release tag ${expectedTag} is missing from the repository.` };
    if (!refResponse.ok) return { state: 'BLOCKED', detail: `GitHub release-tag check returned HTTP ${refResponse.status}.` };
    const ref = JSON.parse(await readBoundedText(refResponse, 65536));
    let tagged = ref.object;
    const seenTags = new Set();
    let depth = 0;
    while (tagged?.type === 'tag') {
      if (!/^[0-9a-f]{40}$/i.test(tagged.sha || '') || seenTags.has(tagged.sha)) {
        return { state: 'FAIL', detail: `GitHub release tag ${expectedTag} contains an invalid or cyclic annotated-tag chain.` };
      }
      if (depth >= 8) return { state: 'FAIL', detail: `GitHub release tag ${expectedTag} exceeds the allowed annotated-tag depth.` };
      seenTags.add(tagged.sha);
      const tagResponse = await fetchImpl(`${TAG_API_ROOT}${encodeURIComponent(tagged.sha)}`, {
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: controller.signal,
        redirect: 'error',
      });
      if (!tagResponse.ok) return { state: tagResponse.status === 404 ? 'FAIL' : 'BLOCKED', detail: 'GitHub could not resolve the annotated release tag.' };
      tagged = JSON.parse(await readBoundedText(tagResponse, 65536)).object;
      depth += 1;
    }
    if (tagged?.type !== 'commit' || tagged.sha !== build.engine_revision) {
      return { state: 'FAIL', detail: `GitHub release tag ${expectedTag} does not resolve to the installed source revision.` };
    }
    return { state: 'PASS', detail: `Installed version ${manifest.version}, engine revision ${build.engine_revision.slice(0, 12)}, and packaged payload digest match the release record; required MCPB/checksum assets are present, the source revision exists, and the release tag resolves to it.` };
  } catch (error) {
    if (error?.name === 'PayloadTooLargeError') return { state: 'FAIL', detail: error.message };
    const detail = error?.name === 'AbortError' ? 'GitHub release check timed out.' : 'GitHub release check could not reach or read the public release record.';
    return { state: 'BLOCKED', detail };
  } finally {
    clearTimeout(timer);
  }
}
