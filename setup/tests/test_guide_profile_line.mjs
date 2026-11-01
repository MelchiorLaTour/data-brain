// A13 on a real Mac (0.1.27): in a fresh chat Claude calls DataBrain only when the user's own profile instructions say so ("Instructions for
// Claude", Settings -> Account). The guide copy box carries the profile rule; the README is outside this guide-only correction. The guide remains
// 12 steps, and once setup is finished the status says as a plain fact that DataBrain answers best with the line in place (the server cannot read it).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, '../..');
const LINE = `For ANY question about me (I, my, me, my life, work, hobbies, plans, or anything I keep or wrote), call databrain_search FIRST, even when general knowledge could answer it; general knowledge is not "memory". Start the answer with "From your files:" and where it comes from; if the answer does not come from DataBrain, start with "From general knowledge:". If DataBrain finds nothing, say so before falling back.`;
const readme = await fs.readFile(path.join(repo, 'README.md'), 'utf8');
const guidePath = process.env.DATABRAIN_GUIDE ?? path.join(repo, 'Mac download', 'Claude app', 'databrain-app-guide.html');
const html = await fs.readFile(guidePath, 'utf8');

const decodeEntities = text => text.replace(/&quot;/g, '"').replace(/&#39;|&#x27;/gi, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const escapeAttribute = text => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
assert.equal(escapeAttribute('A&B "C" \'D\''), 'A&amp;B &quot;C&quot; &#39;D&#39;', 'HTML attribute escaping covers ampersands, quotes, and apostrophes');
const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
const profileButton = buttons.find(match => decodeEntities(match[2].replace(/<[^>]*>/g, '')).includes('call databrain_search FIRST'));
assert(profileButton, 'guide has a visible profile-rule copy button');
const visibleProfileLine = decodeEntities(profileButton[2].replace(/<[^>]*>/g, ''));
assert(visibleProfileLine.startsWith('For ANY question about me (I, my, me, my life, work, hobbies, plans, or anything I keep or wrote)'), 'guide profile rule applies broadly to questions about me');
const copyAttribute = /(?:^|\s)data-copy="([^"]*)"/.exec(profileButton[1]);
assert(copyAttribute, 'profile copy button has a complete quoted data-copy attribute');
assert.equal(copyAttribute[1], escapeAttribute(LINE), 'copy attribute escapes HTML-reserved characters');
assert.equal(decodeEntities(copyAttribute[1]), LINE, 'copy button value equals the full profile rule');
assert.equal(visibleProfileLine, LINE, 'visible copy-button text equals the full profile rule');
assert(readme.includes('`' + LINE + '`'), 'README carries the same current profile rule');
assert(html.includes('For ANY question about me (I, my, me, my life, work, hobbies, plans, or anything I keep or wrote)'), 'guide profile rule applies broadly to questions about me');
assert(html.includes('call databrain_search FIRST, even when general knowledge could answer it'), 'guide explicitly requires DataBrain first, including when general knowledge could answer');
assert(html.includes('general knowledge is not "memory"'), 'general knowledge is not treated as memory');
assert(html.includes('"From your files:"') && html.includes('"From general knowledge:"'), 'guide includes both answer source labels');
assert(html.includes('If DataBrain finds nothing, say so before falling back.'), 'guide discloses no-result search before fallback');
assert(!/check your memory first/i.test(html), 'guide has no memory-first instruction');
assert(!/my notes, recipes, files, plans, lists, reminders/i.test(html), 'guide trigger is not narrowed to notes and recipes');
assert(!/check your memory first/i.test(readme + html), 'neither document tells Claude to check memory first');
for (const [name, text] of [['README', readme], ['guide', html]]) {
  const plain = text.replace(/<strong>(.*?)<\/strong>/g, '$1').replace(/\*\*(.*?)\*\*/g, '$1');
  assert(/Settings…/.test(text) && /Account/.test(text) && /Instructions for Claude/.test(text) && /Profile/.test(text), `${name}: names the exact path (Settings… -> Account -> Instructions for Claude)`);
  assert(/keep all unrelated instructions/i.test(plain) && /replace any older DataBrain instruction with this line/i.test(plain), `${name}: preserves unrelated text and replaces an older DataBrain rule`);
  assert(/if none is present, click at the end of the text, press Return twice, then paste it/i.test(plain), `${name}: appends only when no older DataBrain rule is present`);
}
assert((readme.match(/^\d+ → /gm) || []).length === 12 && (html.match(/class="step"/g) || []).length === 12, 'still 12 steps in both');
assert(!/profile instructions/i.test(readme + html), 'the old guessed field name is gone');
const step12 = text => text.slice(text.indexOf('12 →'), text.indexOf('12 →') + 1500).split(/Then open a/)[0];
const after12 = text => text.slice(text.indexOf('12 →'), text.indexOf('12 →') + 2500);
assert(/send the question DataBrain gave you/.test(after12(readme)) && /send the question DataBrain gave you/.test(after12(html)) && !/In DataBrain, what/.test(readme + html), 'step 12 says to send the question DataBrain gave you (no fixed test message)');
const ALTWORDS = /Folders DataBrain can read/;
assert(readme.includes('This section should look somewhat like this:') && html.includes('This section should look somewhat like this:'), 'step 7 carries the caption in README and guide');
assert(/!\[[^\]]*Folders DataBrain can read[^\]]*\]\(Mac%20download\/Claude%20app\/configure-example\.png\)/.test(readme), 'README references the screenshot with alt text');
assert(/<img [^>]*src="configure-example\.png"[^>]*alt="[^"]*Folders DataBrain can read[^"]*"/.test(html), 'the guide references the screenshot with alt text');
const png = await fs.readFile(path.join(repo, 'Mac download', 'Claude app', 'configure-example.png'));
assert(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && png.length > 20000, 'the screenshot is a real PNG next to the guide');
assert(!/\/Users\/melchior/i.test(readme + html), 'no personal folder path in the README or the guide');
for (const [name, text] of [['README', readme], ['guide', html]]) assert(/⋯/.test(text) && /to the right of (<strong>|\*\*)Configure/.test(text) && /Uninstall(<\/strong>|\*\*) \(red\)/.test(text), `${name}: the uninstall line names the ⋯ button right of Configure and the red Uninstall`);
assert(!/DataBrain → Uninstall/.test(readme + html), 'the old guessed uninstall path is gone');
assert(!/save/i.test(step12(readme) + step12(html)) && !/\[CHECK\]/.test(step12(readme) + step12(html)), 'step 12 says nothing about saving and has no [CHECK] (the box saves by itself, confirmed on a real Mac)');

const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-profileline-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
await fs.writeFile(path.join(docs, 'garden.md'), '# Garden\nprofilelinemarker tomatoes need staking.\n');
await fs.writeFile(path.join(docs, 'payslip-march.md'), 'private by its name\n');
await fs.writeFile(path.join(docs, 'scan0042.md'), '# Refund account\npay to FR7630006000011234567890189 please\n');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let n = 0;
const child = spawn(process.execPath, [path.join(here, '../mcp/server.mjs'), '--databrain-source-roots', docs], { env: { ...process.env, HOME: home }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const tool = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result?.content?.[0]?.text ?? '';
try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  const early = await tool('databrain_setup_status');
  assert(!/profile instructions|Instructions for Claude/.test(early), 'before setup finishes the status does not mention the line');
  await tool('databrain_setup_start');
  let status = '';
  for (const t0 = Date.now(); ; await sleep(400)) {
    status = await tool('databrain_setup_status');
    if (/Stage: ready\./.test(status)) break;
    if (/held back|looks private|privacy/i.test(status)) await tool('databrain_privacy', { action: 'decide', keep: [] });   // the held files stay held
    assert(Date.now() - t0 < 120000, 'setup reaches ready');
  }
  assert(status.includes("DataBrain is ready. DataBrain answers best when Instructions for Claude (Claude → Settings… → Account) include the DataBrain line from the guide."), `status says it as a plain fact once setup is finished, with the box's real name:\n${status.slice(0, 400)}`);
  assert(!/profile instructions/.test(status), 'the status no longer says "profile instructions"');
  const question = /To check it works, open a new chat and ask: what's in my ([^?\n]+)\?/.exec(status);
  assert(question, `the ready message ends with a test question built from a note title:\n${status.slice(0, 500)}`);
  assert(/^garden$/i.test(question[1]) || /^zorblat notes$/i.test(question[1]), `the title is one of the user's own indexed notes (never a held one): ${question[1]}`);
  assert(!/payslip|refund|scan0042/i.test(question[1]), 'a held or private file never gives the test question');
  console.log('PASS: README and guide share the broad search-first profile rule; the guide copy attribute and visible text match; both docs replace only older DataBrain instructions and preserve unrelated profile text; 12 steps and setup integration pass.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
