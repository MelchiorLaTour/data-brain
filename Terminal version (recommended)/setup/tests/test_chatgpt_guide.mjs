// 0.2.1 part 2: the ChatGPT guide follows the Claude guide, with only the differences: at most 12 steps, the installer download and the one-time
// macOS block with its exact path, the picker folder step, the honest privacy sentence word for word, the training-setting note, the
// no Custom Instructions step at all (Mel, 2026-11-16), the repair section and the no-AI recovery. It never names Claude, never says
// that nothing leaves the machine, uses no em-dash, and links the installer by the exact name the build produces.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.DOC_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const html = await fs.readFile(path.join(root, 'ChatGPT app (Mac)/databrain-chatgpt-guide.html'), 'utf8');
const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
const macReadme = await fs.readFile(path.join(root, 'ChatGPT app (Mac)/README.md'), 'utf8');
const plain = text => text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, ' ').replace(/<(?:br|\/li|\/p|\/h\d|\/button|\/span)[^>]*>/g, ' ').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ');
const text = plain(html);

const steps = [...html.matchAll(/<span class="n">(\d+) →<\/span>/g)].map(match => Number(match[1]));
assert.deepEqual(steps, steps.map((_, i) => i + 1), 'steps are numbered 1..n in order');
assert(steps.length <= 12, `at most 12 steps, found ${steps.length}`);

const PRIVACY = "Your files stay on your Mac. DataBrain has no cloud server and stores nothing of yours. On ChatGPT, only the query and the snippets needed to answer it are sent to OpenAI's model.";
for (const [name, doc] of [['guide', text], ['README', plain(readme)]]) assert(doc.includes(PRIVACY), `${name} carries the privacy sentence word for word`);
assert(!/nothing (?:ever )?leaves|nothing is sent/i.test(text + plain(readme) + plain(macReadme)), 'no "nothing leaves the machine" claim');
assert(!/Claude/i.test(text), 'the ChatGPT guide never names Claude');
for (const doc of [html, macReadme, readme]) assert(!doc.includes('—'), 'no em-dash');

// the two things the order names: the installer download and the exact Open Anyway path
assert(html.includes('releases/download/v0.2.1/DataBrain-ChatGPT-Installer-0.2.1.zip'), 'the guide links the versioned installer, never "latest"');
assert(!/releases\/latest/.test(html));
assert(/System Settings → Privacy &amp; Security<\/strong>[\s\S]{0,200}Open Anyway[\s\S]{0,200}password[\s\S]{0,60}Open/.test(html), 'the one-time block and the Open Anyway path are spelled out');
assert(/Install DataBrain for ChatGPT/.test(text) && /Command-Q/.test(text) && /Return/.test(text));

// the same folder step as the Claude guide, done in the picker
for (const word of ['Desktop', 'Documents', 'Downloads', 'Applications', 'Other folders', 'Accept', 'Decline', 'footnote 1']) assert(text.includes(word), `folder step mentions ${word}`);
assert(/leave Desktop, Documents and Downloads ticked/.test(text));
assert(/apps you write in, like Notes/.test(text));
assert(/id="fn1"/.test(html));

// the Claude guide's other sections survive
for (const phrase of ['What DataBrain will not read', 'Resources/Sensitive', 'Scanned images such as IMG_2231.jpg are not checked', 'Your files are safe', 'If something goes wrong', 'If DataBrain stops working', 'Run DataBrain repair', 'Re-approve my folder <name> in DataBrain', 'Run DataBrain diagnostics', 'Improve the model for everyone', 'Files & Folders']) assert(text.includes(phrase), `missing: ${phrase}`);
assert(/does not exist[\s\S]{0,200}not a repair problem/.test(text), 'a missing folder is named and is not sent to repair');
assert(/Run the installer again[\s\S]{0,200}keeps your folders/.test(text), 'the no-AI recovery says installing again keeps the brain');

// Part 21 (Mel, 2026-11-16): a ChatGPT user is never asked to paste anything into Custom Instructions. Nothing the user can read mentions them:
// the guide, both READMEs' ChatGPT parts, the installer and uninstaller, the skill and the build script.
const NO_CI = /custom[\s-]*instruction|personali[sz]ation|copy-line|data-copy="[^"]*databrain_search/i;
const chatgptDocs = [['guide html', html], ['ChatGPT README', macReadme], ['front page README', readme]];
for (const rel of ['setup/chatgpt/Install DataBrain for ChatGPT.command', 'setup/chatgpt/Uninstall DataBrain for ChatGPT.command', 'setup/chatgpt/build.sh', 'setup/chatgpt/skills/databrain-save-note/SKILL.md']) chatgptDocs.push([rel, await fs.readFile(path.join(root, 'Terminal version (recommended)', rel), 'utf8')]);
for (const [name, doc] of chatgptDocs) assert(!NO_CI.test(doc), `${name} must not mention Custom Instructions or Personalization`);
assert(!/<button class="copy"[^>]*databrain_search/.test(html), 'no pasted search rule in the guide');
assert(/Private files review\.txt/.test(text) && /keep: no[\s\S]{0,40}keep: yes/.test(text) && /I reviewed my private files/.test(text) && /never says which/.test(text), 'the guide says how to keep a private file: the review file, keep: yes, and the sentence to tell ChatGPT');
assert(/When ChatGPT says DataBrain is ready, open a new chat and ask about something that is in your files/.test(text), 'the guide still says when to try it');

// every screen name that has not been checked on a Mac carries a [CHECK] marker
const checks = (html.match(/class="check">\[CHECK\]/g) || []).length;
assert(checks >= 8, `screen names are marked [CHECK] (${checks})`);
assert(/Pre-release/.test(text) && !/Tested on one Mac/.test(text), 'the page does not claim testing it did not have');

// Part 29 C (Mel, 2026-11-21): step 1 is the training setting (before anything is downloaded); step 2 says exactly where the file is
{
  const stepText = n => plain(html.match(new RegExp(`<span class="n">${n} →</span>([\\s\\S]*?)</li>`))?.[1] ?? '');
  assert(/Improve the model for everyone/.test(stepText(1)) && /before you download anything/.test(stepText(1)), `step 1 is the Improve the model setting: ${stepText(1).slice(0, 120)}`);
  assert(!/Improve the model for everyone/.test(steps.slice(1).map(stepText).join(' ')), 'the training setting is only step 1');
  for (const phrase of ['data-brain', 'ChatGPT app (Mac)', 'download link in the heading', 'only opens a preview page']) assert(stepText(2).includes(phrase), `step 2 says "${phrase}": ${stepText(2).slice(0, 200)}`);
  assert(readme.includes('(ChatGPT%20app%20%28Mac%29)'), 'the front page links the ChatGPT app (Mac) folder');
  assert(macReadme.includes('Use the link in this heading instead'), 'the folder README says to use the download link in the heading');
}
// part 34: ChatGPT's own "Enable ChatGPT Computer Use" window is not DataBrain's; step 10 says so in one small italic note
{
  const stepHtml = n => html.match(new RegExp(`<span class="n">${n} →</span>([\\s\\S]*?)</li>`))?.[1] ?? '';
  const note = stepHtml(10).match(/<span class="fine"><em>([\s\S]*?)<\/em><\/span>/)?.[1] ?? '';
  assert(note, 'step 10 carries the Computer Use note: italic (<em>) inside a small-print span');
  const noteText = plain(note);
  assert(/"Enable ChatGPT Computer Use"/.test(noteText) && /Accessibility/.test(noteText) && /Screenshots/.test(noteText) && /Chrome Extension/.test(noteText), `the note names the window and what it asks for: ${noteText}`);
  assert(/you can close it/.test(noteText) && /DataBrain does not need it/.test(noteText), `the note says to close it and that DataBrain does not need it: ${noteText}`);
  assert(/access to your folders/.test(noteText) && /permission to control that app/.test(noteText), `the note lists what DataBrain does need: ${noteText}`);
  assert(!noteText.includes('—'), 'no em-dash in the note');
  assert.equal((stepHtml(10).match(/\[CHECK\]/g) || []).length, 1, 'step 10 keeps its one [CHECK] marker');
  for (const n of steps.filter(n => n !== 10)) assert(!/Computer Use/.test(stepHtml(n)), `the note is only in step 10, not step ${n}`);
  const fine = html.match(/\.fine\s*\{([^}]*)\}/)?.[1] ?? '';
  assert(/font-style:\s*italic/.test(fine) && Number(fine.match(/font-size:\s*(\d+)px/)?.[1]) <= 15 && /color:\s*var\(--muted\)/.test(fine), `.fine is small italic muted text (readable on the guide's dark page): ${fine}`);
}
// the README and the downloads folder point at the same installer
assert(macReadme.includes('raw/main/ChatGPT%20app%20%28Mac%29/DataBrain-ChatGPT-Installer-0.2.1.zip'), 'the folder README links the installer at its new path');
console.log(`PASS: ChatGPT guide: ${steps.length} steps, the installer and the Open Anyway path, the picker folder step, the privacy sentence word for word, the training note, no Custom Instructions anywhere, repair and no-AI recovery, no Claude wording, no em-dash, ${checks} [CHECK] markers.`);
