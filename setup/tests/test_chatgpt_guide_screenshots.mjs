// 0.2.1 part 30 (Mel, 2026-11-23): three of Mel's screenshots in the ChatGPT guide, so a new user sees what to click.
// The images are embedded as data: URIs, so the guide shows them opened as a local file and from GitHub with no other file to ship.
// Fails if an image is missing, sits in the wrong step or before the sentence it shows, has empty alt text, is not a real PNG,
// is wider than the cap, or if any image in the guide points at a file (a file reference would also have to ship in the zip).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.DOC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = await fs.readFile(path.join(root, 'Mac download/ChatGPT app/databrain-chatgpt-guide.html'), 'utf8');
const step = n => html.match(new RegExp(`<span class="n">${n} →</span>([\\s\\S]*?)</li>`))?.[1] ?? '';

const SHOTS = [
  // [name, step, text that must come before the image in that step, text that must come after it (or null), alt must name]
  ['step3-installer-folder', 3, 'double-click <strong>Install DataBrain for ChatGPT</strong>', null, /Install DataBrain for ChatGPT/],
  ['step4-not-opened', 4, 'Click <strong>Done</strong>.', 'System Settings', /Done/],
  ['step4-open-anyway', 4, 'and click <strong>Open</strong>.', null, /Open Anyway/],
];

const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map(m => m[0]);
const attr = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];

// every image in the guide is embedded: a src that points at a file would have to ship next to the guide and in the zip
for (const tag of imgs) assert(/^data:image\/png;base64,/.test(attr(tag, 'src') ?? ''), `every guide image is embedded, not a file reference: ${tag.slice(0, 120)}`);

for (const [name, n, before, after, altMust] of SHOTS) {
  const body = step(n);
  const tag = body.match(new RegExp(`<img\\b[^>]*data-shot="${name}"[^>]*>`))?.[0];
  assert(tag, `step ${n} has the ${name} screenshot`);
  const alt = attr(tag, 'alt');
  assert(alt && alt.trim().length >= 20, `${name} has alt text describing what to click: "${alt ?? ''}"`);
  assert(altMust.test(alt), `${name} alt text names what to click (${altMust}): "${alt}"`);
  assert(/\bclass="shot"/.test(tag), `${name} uses the capped .shot style`);
  const at = body.indexOf(tag);
  assert(body.indexOf(before) >= 0 && body.indexOf(before) < at, `${name} comes after "${before}" (step text first, image under it)`);
  if (after) assert(body.indexOf(after, at) > at, `${name} comes before "${after}"`);
  const png = Buffer.from(attr(tag, 'src').replace(/^data:image\/png;base64,/, ''), 'base64');
  assert(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.toString('latin1', 12, 16) === 'IHDR', `${name} is a real PNG`);
  assert(png.readUInt32BE(16) > 200 && png.readUInt32BE(20) > 200, `${name} is not an empty placeholder (${png.readUInt32BE(16)}x${png.readUInt32BE(20)})`);
}
assert.equal(imgs.length, SHOTS.length, `exactly the ${SHOTS.length} screenshots, found ${imgs.length}`);

// width cap so step text stays on a laptop screen: about 360 to 420 px
const rule = html.match(/\.shot\s*\{([^}]*)\}/)?.[1] ?? '';
const max = Number(rule.match(/max-width:\s*(\d+)px/)?.[1]);
assert(max >= 360 && max <= 420, `.shot max-width is 360-420 px (found ${rule.trim() || 'no .shot rule'})`);
assert(/display:\s*block/.test(rule) && /height:\s*auto/.test(rule), '.shot sits on its own line under the text and keeps its proportions');

console.log(`PASS: ChatGPT guide screenshots: ${SHOTS.length} embedded PNGs in steps 3 and 4, each after the sentence it shows, alt text on each, max-width ${max}px.`);
