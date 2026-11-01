// The guide and README sentences about repair. Each claim is backed by a test: repair itself (test_mcp_repair.mjs), the reinstall
// (test_mcp_reinstall_reuses_brain.mjs) and install-over-old (test_mcp_update_keeps_brain.mjs). This test checks the wording stays
// inside what those prove: the section sits outside the 12 steps, has the two paste lines, never says to uninstall first.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');
const html = await fs.readFile(process.env.DATABRAIN_GUIDE ?? path.join(repo, 'Mac download', 'Claude app', 'databrain-app-guide.html'), 'utf8');
const readme = await fs.readFile(path.join(repo, 'README.md'), 'utf8');
const copies = [...html.matchAll(/data-copy="([^"]*)"/g)].map(m => m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
assert(copies.includes('Run DataBrain repair'), 'paste line: Run DataBrain repair');
assert(copies.includes('Re-approve my folder <name> in DataBrain'), 'paste line: Re-approve my folder <name> in DataBrain');
const list = html.slice(html.indexOf('<ol>'), html.indexOf('</ol>'));
assert.equal((list.match(/class="step"/g) || []).length, 12, 'still 12 numbered steps');
assert(!list.includes('stops working') && !list.includes('Run DataBrain repair'), 'the new section is outside the numbered steps');
assert(html.indexOf('If DataBrain stops working') > html.indexOf('</ol>'));
for (const [name, text] of [['guide', html], ['README', readme]]) {
  assert(!/uninstall (it |DataBrain )?first/i.test(text), `${name} never tells the client to uninstall first`);
  assert(/Files (&amp;|&) Folders/.test(text) && /Enabled|turn the extension on/i.test(text), `${name} has the no-Claude recovery paths`);
  assert(/not re-checked/.test(text), `${name} words the menu paths as untested`);
}
assert(/Run DataBrain repair/.test(readme) && /Re-approve my folder <name> in DataBrain/.test(readme));
console.log('PASS: the guide and README have a repair section outside the 12 steps with the two paste lines, the no-Claude recovery paths, the reinstall claim, no "uninstall first", and untested menu names are worded as untested.');
