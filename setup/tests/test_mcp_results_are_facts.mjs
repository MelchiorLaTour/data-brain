// The Claude app treats instructions that arrive inside a tool RESULT as untrusted (it said so about a DataBrain status, 2026-10-11, and then
// skipped DataBrain). So tool results carry facts only; the rules for Claude live in the tool descriptions.
// This test takes a tour of every state a user can reach, collects every tool result, and fails if any of them contains text that tells the
// assistant what to do. It also checks the tool descriptions carry the rules, and that the privacy numbers in status are labelled and agree
// with the held list (one "Held back for privacy" line; waiting and excluded are different numbers, each named).
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
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 120000) { for (const t0 = Date.now(); !(await check()); await sleep(250)) assert(Date.now() - t0 < limit, `timed out: ${label}`); }
const IBAN = 'FR1420041010050500013M02606';

// ---- what counts as telling the assistant what to do
const RESTART = 'To start again, send Set up my DataBrain.';   // Mel's wording for the user after a cancelled window; it is for the user, so it is allowed
const REPAIR_LINE = 'DataBrain repair is available: ask Claude to run DataBrain repair.';   // the one labelled line that names the repair; the only exception, exact text only
const CONSENT_WARNING = 'These come from your DataBrain settings. Some may be left over from an earlier install. Check each one before you say yes.';   // Mel's exact words for the user at setup consent; allowed like RESTART
const IMPERATIVE_START = /^(?:tell|show|say|offer|ask|call|use|run|repeat|search|read|check|select|choose|open|click|add|remove|turn|try|refresh|retry|review|resolve|continue|wait|stop|quit|restart|explain|send|give|copy|keep|let|make|allow|grant|press|go|look|remember|ensure|confirm|provide|start|do not|don't|never|always|please)\b/i;
const DIRECTIVE = [
  [/\b(?:tell|show|say|offer|ask|explain|repeat|remind|mention|inform|suggest|recommend)\s+(?:the user|them|him|her|this|that|it|exactly|first|in |what|again)/i, 'a verb of telling or showing aimed at the user'],
  [/\bdatabrain_[a-z_]+/i, 'a tool name'],
  [/\b(?:do not|don't|never|must|should|always|please)\b/i, 'a rule word'],
  [/\byou\b/i, 'the word you'],
];
function directives(text) {
  const found = [];
  for (const raw of text.replace(RESTART, '').replace(CONSENT_WARNING, '').replaceAll(REPAIR_LINE, '').split(/\n/)) {
    const line = raw.trim();
    if (!line || /^- \S/.test(line) || /^[0-9]+\s+-?[0-9.]+\s+/.test(line) || /^Variant \d+:/.test(line)) continue;   // a listed file (name and reason), a ranked hit, a query echo
    for (const sentence of line.split(/(?<=[.!?])\s+/)) {
      const bare = sentence.replace(/^[A-Za-z ]{0,30}:\s+(?=\S)/, '').trim();   // "Freshness: Tell…" -> "Tell…"
      if (/^[A-Z]/.test(bare) && IMPERATIVE_START.test(bare)) found.push(`[starts like an order] ${sentence.trim()}`);
      for (const [pattern, why] of DIRECTIVE) if (pattern.test(sentence)) found.push(`[${why}] ${sentence.trim()}`);
    }
  }
  return found;
}

const collected = [];
function connect(home, roots, env = {}) {
  const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', ...roots], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '100', ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let n = 0;
  readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
  const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
  const tool = async (name, args = {}, { headerOnly = false } = {}) => {
    const reply = await ask('tools/call', { name, arguments: args });
    const text = reply.result?.content?.[0]?.text ?? reply.error?.message ?? '';
    collected.push({ where: `${name} ${JSON.stringify(args).slice(0, 60)}`, text: headerOnly ? text.split('\n').slice(0, 2).join('\n') : text });   // an excerpt of the user's own file is the user's text, not ours
    return text;
  };
  const ready = (async () => { await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n'); })();
  return { child, ask, tool, ready };
}
async function fresh(prefix) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents'); await fs.mkdir(path.join(docs, 'notes'), { recursive: true });
  const root = await fs.realpath(docs);
  await fs.writeFile(path.join(root, 'notes', 'cookie.md'), '# Cookie recipe\nfactscookiemarker flour sugar butter.\n');
  await fs.writeFile(path.join(root, 'notes', 'plain.md'), '# Plain\nfactsplainmarker an ordinary note.\n');
  return { temp, home, root, dataHome: path.join(home, 'DataBrain') };
}
const privacyCounts = async dataHome => {
  const last = new Map();
  for (const line of (await fs.readFile(path.join(dataHome, '.databrain', 'privacy.tsv'), 'utf8').catch(() => '')).split('\n')) { const [status, file] = line.split('\t'); if (file) last.set(file, status); }
  const count = status => [...last.values()].filter(value => value === status).length;
  return { waiting: count('held'), excluded: count('excluded') };
};
const temps = []; const servers = [];
const settle = async (server, onPause) => until(async () => {
  const status = await server.tool('databrain_setup_status');
  if (status.startsWith('SETUP PAUSED FOR PRIVACY REVIEW')) await onPause();
  return /Stage: ready\./.test(status);
}, 'setup reaches ready');

try {
  // ---- A) the main tour: not configured -> start -> privacy pause -> ready -> searches -> held files -> status numbers
  const a = await fresh('databrain-facts-a-'); temps.push(a.temp);
  await fs.writeFile(path.join(a.root, 'payslip-march.md'), 'factspayslipmarker looks private by its name\n');
  const A = connect(a.home, [a.root]); servers.push(A); await A.ready;
  const specs = (await A.ask('tools/list', {})).result.tools;
  const description = name => specs.find(tool => tool.name === name)?.description ?? '';
  for (const name of ['databrain_search', 'databrain_abstain_check']) {
    const text = description(name);
    assert(/own notes, documents, reminders and files/.test(text), `${name}: identifies the user's files`);
    if (name === 'databrain_search') assert(/for ANY question about the user.*call databrain_search FIRST/i.test(text), `${name}: carries the always-first rule formerly carried by initialize instructions`);
    else assert(/whenever Claude's memory does not have the answer/i.test(text), `${name}: says when to use multi-variant checking`);
    assert(text.includes('"From your files:"') && /found nothing/.test(text) && /do not guess/.test(text), `${name}: says how to answer and what to do when nothing is found`);
    assert(text.includes('"From general knowledge:"'), `${name}: says an answer that does not come from DataBrain starts "From general knowledge:"`);
    assert(text.includes('"check my files"') && text.includes('"in DataBrain"') && text.includes('"look it up"') && /even when (Claude's )?memory has an answer/.test(text), `${name}: says "check my files", "in DataBrain" and "look it up" make Claude call DataBrain even when memory has an answer`);
  }
  // tool choice (2026-10-12: in a new chat Claude said it did not know the dish and asked where the recipe lives, and never called DataBrain)
  for (const name of ['databrain_search', 'databrain_abstain_check']) assert(/before saying (?:it does|you do) not know/i.test(description(name)) && /before asking (the user )?where something is kept/i.test(description(name)), `${name}: says to call it BEFORE saying "I do not know" and before asking where something is kept`);
  assert(/"my recipe"/.test(description('databrain_search')) && /"my plan"/.test(description('databrain_search')), 'search: names the kind of question ("my ...") that goes to DataBrain');
  assert(/^Search my notes, documents, reminders and files$/.test(specs.find(tool => tool.name === 'databrain_search')?.title ?? ''), 'search: has a plain title that names the user\'s own things');
  assert(!/on in this chat/.test(description('databrain_search')) && /installed in Claude/.test(description('databrain_search')), 'search: the other-connection wording says installed, never "on in this chat"');
  // tool deferral (2026-10-12, real Mac: a NEW chat never called DataBrain because the app defers extension tools behind tool search and the model
  // saw only tool names plus the start of the server instructions): the "my ..." tools are marked always-loaded, and the trigger is the FIRST sentence
  for (const name of ['databrain_search', 'databrain_abstain_check', 'databrain_read']) assert(specs.find(tool => tool.name === name)?._meta?.['anthropic/alwaysLoad'] === true, `${name}: is marked always-loaded (anthropic/alwaysLoad) so a new chat sees it without tool search`);
  assert(specs.filter(tool => tool._meta?.['anthropic/alwaysLoad']).length === 3, 'only those three tools are marked always-loaded');
  assert(/"my recipe"/.test(description('databrain_search')) && /databrain_search/.test(description('databrain_search')) && /BEFORE saying you do not know/.test(description('databrain_search')), 'search description carries the personal-question trigger formerly carried by initialize instructions');
  assert(/ONE plain sentence/.test(description('databrain_verify_install')) && /not problems/.test(description('databrain_verify_install')) && !/summarize each PASS/.test(description('databrain_verify_install')), 'verify-install description carries the audit-report rule formerly carried by initialize instructions');
  assert(/Freshness line/.test(description('databrain_search')) && /another DataBrain connection/.test(description('databrain_search')), 'search: says what a Freshness line and an other-connection line mean');
  assert(/never tell the user to quit Claude/.test(description('databrain_setup_status')) && /DataBrain is ready/.test(description('databrain_setup_status')), 'setup_status: carries the setup rules');
  assert(/NEVER suggest keeping any file/.test(description('databrain_privacy')), 'privacy: carries the review rules');
  assert(/Call this again with confirmed true only after the user says yes in the chat/.test(description('databrain_setup_start')), 'setup_start: says when to call it');

  await A.tool('databrain_setup_status');                       // settings saved, not started
  await A.tool('databrain_setup_start');
  await settle(A, async () => { await A.tool('databrain_privacy', { action: 'list' }); await A.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  await A.tool('databrain_search', { query: 'factscookiemarker' });
  await A.tool('databrain_search', { query: 'factsnomatchzzz' });
  const hit = await A.tool('databrain_abstain_check', { queries: ['factscookiemarker', 'cookie recipe flour'] });
  await A.tool('databrain_abstain_check', { queries: ['factsnomatchzzz', 'factsnothingzzz'] });
  const target = hit.split('\n').map(l => l.match(/^\s*\d+\s+-?[0-9.]+\s+(.+)$/)?.[1]).find(Boolean);
  if (target) await A.tool('databrain_read', { path: target.replace(/^~/, a.home) }, { headerOnly: true });
  for (const [name, args] of [['databrain_health'], ['databrain_diagnostics'], ['databrain_verify_install'], ['databrain_cloud_check'], ['databrain_taxonomy_candidates'], ['databrain_build_relationships'], ['databrain_refresh'], ['databrain_setup_run'], ['databrain_cancel_job', { job_id: 'none' }], ['databrain_cloud_fetch'], ['databrain_privacy', { action: 'decide', keep: ['not-in-the-list.md'] }], ['databrain_privacy', { action: 'decide', keep: [3] }], ['databrain_search', { query: '' }]]) await A.tool(name, args ?? {});
  await settle(A, async () => { await A.tool('databrain_privacy', { action: 'list' }); await A.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  // a new private file after setup: held, announced once, counted once
  await fs.writeFile(path.join(a.root, 'notes', 'late-secret.md'), `factslatemarker my iban is ${IBAN}\n`);
  await sleep(300);
  await A.tool('databrain_search', { query: 'factsplainmarker' });
  await until(async () => (await privacyCounts(a.dataHome)).waiting >= 1, 'the new private file is held', 60000);
  await sleep(500);
  const counts = await privacyCounts(a.dataHome);
  const status = await A.tool('databrain_setup_status');
  const heldLines = status.split('\n').filter(line => /^Held back for privacy/.test(line));
  assert.equal(heldLines.length, 1, `status has one line that counts held files, not several:\n${heldLines.join('\n')}`);
  const otherCounts = status.split('\n').filter(line => !/^Held back for privacy/.test(line) && (/\b\d+\s+(?:file\(s\)|files?)\b[^.]*(?:held back|withheld)/i.test(line) || /(?:held back|withheld)[^.]*\b\d+\b/i.test(line.replace(/job ID [0-9a-f-]+/g, ''))));
  assert.deepEqual(otherCounts, [], `no other line gives a number of held files:\n${otherCounts.join('\n')}`);
  const expected = `Held back for privacy: ${counts.waiting} file(s) waiting for the user's decision${counts.excluded ? `; ${counts.excluded} file(s) the user chose to exclude` : ''}.`;
  assert.equal(heldLines[0], expected, `the one line names each number: waiting ${counts.waiting}, excluded ${counts.excluded}`);
  assert(counts.waiting >= 1 && counts.excluded >= 1, `the tour has both kinds of number to tell apart: ${JSON.stringify(counts)}`);
  const listed = await A.tool('databrain_privacy', { action: 'list' });
  assert(listed.startsWith(`Held back for privacy: ${counts.waiting} file(s) waiting for the user's decision.`), `the list names the same number:\n${listed}`);
  assert(!/Setup is paused/.test(listed), 'a list shown after setup does not claim setup is paused');
  const search = await A.tool('databrain_search', { query: 'factsplainmarker' });
  assert(!/held back/i.test(search) || search.includes(`Held back for privacy: ${counts.waiting} file(s) waiting`), `a notice on a search names the same number:\n${search.slice(0, 300)}`);
  assert(!/are held back for privacy/.test(status), 'the inventory line no longer carries a second, unlabeled count');

  // ---- B) a stale index: the sentence that new changes are being added, then a refresh already running
  const b = await fresh('databrain-facts-b-'); temps.push(b.temp);
  const B = connect(b.home, [b.root], { DATABRAIN_TEST_UPDATE_DELAY_MS: '3500', DATABRAIN_TEST_FRESH_CAP_MS: '800' }); servers.push(B); await B.ready;
  await B.tool('databrain_setup_start');
  await settle(B, async () => { await B.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  await sleep(1500);
  await fs.appendFile(path.join(b.root, 'notes', 'plain.md'), '\nfactsstalemarker added after setup.\n');
  await sleep(300);
  const slow = await B.tool('databrain_search', { query: 'factsstalemarker' });
  assert(/New changes are being added/.test(slow), `the stale case was reached:\n${slow.slice(0, 300)}`);
  await sleep(300);
  await B.tool('databrain_search', { query: 'factsplainmarker' });
  await B.tool('databrain_setup_status');
  await B.tool('databrain_abstain_check', { queries: ['factsstalemarker', 'stale marker added'] });

  // ---- C) another DataBrain connection switched on in the same chat
  const c = await fresh('databrain-facts-c-'); temps.push(c.temp);
  const configPath = path.join(c.home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: { databrain: { command: '/usr/local/bin/node', args: ['/Users/someone/other-brain/server.js'] } } }));
  const C = connect(c.home, [c.root]); servers.push(C); await C.ready;
  await C.tool('databrain_setup_start');
  await settle(C, async () => { await C.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  const other = await C.tool('databrain_search', { query: 'factscookiemarker' });
  assert(/Another DataBrain connection is installed in Claude/.test(other), `the other-connection case was reached:\n${other.slice(0, 200)}`);
  await C.tool('databrain_setup_status');

  // ---- D) the folder list was shown in the chat and the user has not said yes: nothing was read
  const d = await fresh('databrain-facts-d-'); temps.push(d.temp);
  const D = connect(d.home, [d.root], { DATABRAIN_TEST_CONSENT: 'ask' }); servers.push(D); await D.ready;
  await D.tool('databrain_setup_start');
  assert(/Nothing has been read or changed yet/.test(await D.tool('databrain_setup_start')) && !/Stage: (?:indexing|ready)/.test(await D.tool('databrain_setup_status')), 'the list is shown and nothing is indexing before the yes');
  await D.tool('databrain_search', { query: 'factscookiemarker' });
  await D.tool('databrain_health');

  // ---- E) a DataBrain folder that is not ours is already there: the brain goes in "DataBrain 2" and the results say where
  const e = await fresh('databrain-facts-e-'); temps.push(e.temp);
  await fs.mkdir(path.join(e.home, 'DataBrain'), { recursive: true }); await fs.writeFile(path.join(e.home, 'DataBrain', 'someone-elses.txt'), 'not ours\n');
  const E = connect(e.home, [e.root]); servers.push(E); await E.ready;
  await E.tool('databrain_setup_status');
  const started = await E.tool('databrain_setup_start');
  await settle(E, async () => { await E.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  const placed = await E.tool('databrain_setup_status');
  assert(/DataBrain 2/.test(placed) && /DataBrain 2/.test(started + placed), `the foreign-folder case was reached:\n${placed.slice(0, 300)}`);

  // ---- F) a replaced folder: the error, diagnostics and repair results carry facts and the one labelled repair line
  const f = await fresh('databrain-facts-f-'); temps.push(f.temp);
  const F = connect(f.home, [f.root]); servers.push(F); await F.ready;
  await F.tool('databrain_setup_start');
  await settle(F, async () => { await F.tool('databrain_privacy', { action: 'decide', keep: [] }); });
  F.child.kill('SIGTERM'); await sleep(800);
  await fs.rename(f.root, `${f.root}-old`); await fs.cp(`${f.root}-old`, f.root, { recursive: true });
  const F2 = connect(f.home, [f.root]); servers.push(F2); await F2.ready;
  const replacedError = await F2.tool('databrain_search', { query: 'factsplainmarker' });
  assert(replacedError.includes(REPAIR_LINE), `the error ends with the repair line:\n${replacedError}`);
  await F2.tool('databrain_diagnostics');
  await F2.tool('databrain_repair');
  await F2.tool('databrain_verify_install');
  // the exception is exact: any other wording is still an order
  assert(directives('Tell the user to run DataBrain repair.').length > 0, 'a directive about repair is still caught');
  assert(directives(`Run DataBrain repair now. ${REPAIR_LINE}`).length > 0, 'an order next to the repair line is still caught');
  const listedTools = (await F2.ask('tools/list', {})).result.tools;
  for (const tool of ['databrain_search', 'databrain_diagnostics', 'databrain_verify_install']) {
    const spec = listedTools.find(t => t.name === tool);
    assert(/offer databrain_repair/.test(spec.description) && /never tell the user to rename, move or delete the DataBrain folder/.test(spec.description), `${tool} carries the repair rule`);
  }

  // ---- the verdict
  const offenders = [];
  for (const { where, text } of collected) for (const found of directives(text)) offenders.push(`${where}\n      ${found}`);
  assert.equal(offenders.length, 0, `${offenders.length} tool-result sentence(s) tell the assistant what to do (results carry facts; rules belong in tool descriptions):\n  ${[...new Set(offenders.map(o => o.split('\n').slice(1).join(' ').trim()))].join('\n  ')}`);
  assert(collected.length > 40, `the tour collected results from many calls (${collected.length})`);
  console.log(`PASS: ${collected.length} tool results from the whole tour (not configured, privacy pause, ready, searches, held files, stale index, other connection, cancelled window, foreign folder) contain facts only; the search tools say when to use them and how to answer; status shows one labelled held-back line whose numbers match the list.`);
} finally {
  for (const x of servers) x.child.kill('SIGKILL');
  await sleep(1000);
  for (const t of temps) await fs.rm(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
