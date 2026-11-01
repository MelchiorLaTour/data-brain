// The download file is always called databrain.mcpb (Mel, 2026-10-12). The guide and the README must never name a versioned package
// (databrain-0.1.20.mcpb, a /releases/download/v0.1.20/ link): that sends the reader to a file that no longer is the current one.
// DOC_ROOT can point at another copy of the repository to prove the test fails on old documents.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.DOC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const docs = ['README.md', 'Mac download/Claude app/README.md', 'Mac download/Claude app/databrain-app-guide.html'];
const versioned = /databrain[-_ ]v?\d+(\.\d+)+[^\s"'<>)]*\.mcpb|\/releases\/download\/v?\d/ig;
const texts = {};
for (const doc of docs) {
  texts[doc] = await fs.readFile(path.join(root, doc), 'utf8');
  const hits = texts[doc].match(versioned) || [];
  assert.deepEqual(hits, [], `${doc} names a versioned package: ${hits.join(' | ')}`);
}
// the two documents with the numbered steps carry the fixed name in step 1 and step 5, and keep the duplicate-name hint
for (const doc of ['README.md', 'Mac download/Claude app/databrain-app-guide.html']) {
  const text = texts[doc];
  assert(text.includes('releases/latest/download/databrain.mcpb'), `${doc}: step 1 must link releases/latest/download/databrain.mcpb`);
  assert(/click (\*\*|<strong>)databrain\.mcpb(\*\*|<\/strong>)/.test(text), `${doc}: step 5 must tell the reader to click databrain.mcpb`);
  assert(/databrain \(1\)\.mcpb/.test(text), `${doc}: the "(1)" duplicate-name hint must stay`);
}
console.log('PASS: the README and the guide name only databrain.mcpb (latest-release link in step 1, file name in step 5, "(1)" hint kept); no versioned package name anywhere.');
