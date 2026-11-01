// Which scripting-dictionary classes are read, which apps are skipped, and how an app is started. Dictionaries here are made up; no real app
// is touched, and no app name appears in the product code (only the generic words contact/person/event/document and media properties).
//  1) classes: only items with a real written body are read; media, documents, filters and other metadata yield nothing; an app whose
//     dictionary has people or events is not read at all (found through class names and properties);
//  2) lifecycle: an app that was not running is started hidden, read, and LEFT RUNNING (never quit, so the next check does not relaunch it);
//     one that was running is left alone; a people/events app gets no question at all;
//  3) names from a dictionary that are not plain words (a script injection attempt) mean the app is skipped and nothing runs.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// The hooks used below are ignored when HOME is the real home (a real session never honours them), so this in-process test uses its own HOME.
process.env.HOME = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-classes-home-')));
const readers = await import(path.join(here, '../mcp/app-readers.mjs'));

// ---- 1) classes
const prop = (name, type = 'text') => `<property name="${name}" code="xxxx" type="${type}"/>`;
const cls = (name, props, inherits = '') => `<class name="${name}" code="xxxx" plural="${name}s"${inherits ? ` inherits="${inherits}"` : ''}>${props.map(p => Array.isArray(p) ? prop(...p) : prop(p)).join('')}</class>`;
const found = (...classes) => readers.findTextClasses(readers.parseSdef(`<dictionary><suite name="S">${classes.join('')}</suite></dictionary>`));
const byName = list => Object.fromEntries(list.map(d => [d.className, d]));

const mixed = byName(found(
  cls('page', ['title', 'text', ['id', 'text'], ['modification date', 'date']]),                                        // a written body: read
  cls('track', ['name', 'description', 'text', 'artist', ['duration', 'real']]),                                       // media: nothing
  cls('picture', ['name', 'text', ['width', 'integer'], ['height', 'integer']]),                                       // media: nothing
));
Object.assign(mixed, byName(found(
  cls('filter', ['name', 'description']),                                                                             // metadata only: nothing
  cls('sheet', ['name', 'text'], 'document'), cls('document', ['name', 'text']),                                       // a document (and what inherits it): nothing
  cls('counter', ['name', ['text', 'integer']]),                                                                       // the "text" is not text
)));
assert.deepEqual(Object.keys(mixed), ['page'], `read classes: ${Object.keys(mixed)}`);
assert.equal(mixed.page.body, 'text');
const dictionary = (...classes) => readers.parseSdef(`<dictionary><suite name="S">${classes.join('')}</suite></dictionary>`);
assert.equal(readers.hasPeopleOrEvents(dictionary(cls('page', ['title', 'text']))), false, 'an ordinary dictionary is read');
for (const [label, classesXml] of [
  ['person by class name', cls('contact', ['name', 'note'])],
  ['person by properties alone', cls('thing', ['name', 'note', 'first name', 'last name'])],
  ['event by class name', cls('meeting', ['summary', 'description'])],
  ['event by properties alone', cls('slot', ['summary', ['start date', 'date'], ['end date', 'date']])],
  ['person with no body at all', cls('contact', ['name', 'email'])],
]) assert.equal(readers.hasPeopleOrEvents(dictionary(cls('page', ['title', 'text']), classesXml)), true, `${label}: the app is skipped`);
assert.deepEqual(found(cls('contact', ['name', 'note'])), [], 'a people class is never read');

// ---- 2) and 3) start / stop and the held folders
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-classes-')));
try {
  const log = path.join(temp, 'calls.log');
  const rows = path.join(temp, 'rows.json');
  const stub = path.join(temp, 'osascript-stub.mjs');
  await fs.writeFile(stub, `#!/usr/bin/env node
import fs from 'node:fs';
fs.appendFileSync(process.env.CALL_LOG, 'read\\n');
console.log(fs.readFileSync(process.env.ROWS, 'utf8'));
`, { mode: 0o755 });
  const lifecycle = path.join(temp, 'lifecycle-stub.mjs');
  await fs.writeFile(lifecycle, `#!/usr/bin/env node
import fs from 'node:fs';
const [action, id] = process.argv.slice(2);
const state = process.env.STATE;
const exists = fs.existsSync(state);
fs.appendFileSync(process.env.CALL_LOG, action + '\\n');
if (action === 'launch') fs.writeFileSync(state, 'on');
if (action === 'running') console.log(exists || process.env.ALWAYS_RUNNING === '1' ? 'true' : 'false');
`, { mode: 0o755 });
  const sdefPath = path.join(temp, 'D.sdef');
  await fs.writeFile(sdefPath, `<dictionary><suite name="S">${cls('card', ['title', 'text', ['id', 'text']])}</suite></dictionary>`);
  const personSdef = path.join(temp, 'P.sdef');
  await fs.writeFile(personSdef, `<dictionary><suite name="S">${cls('contact', ['name', 'note', ['id', 'text']])}</suite></dictionary>`);
  process.env.DATABRAIN_TEST_APP_OSASCRIPT = stub;
  process.env.DATABRAIN_TEST_APP_LIFECYCLE = lifecycle;
  process.env.CALL_LOG = log; process.env.ROWS = rows; process.env.STATE = path.join(temp, 'running');
  const readApp = async (name, sdef) => {
    const mirrorRoot = path.join(temp, `mirror-${name}`);
    const { summaries } = await readers.exportApps({ roots: [temp], mirrorRoot, apps: [{ name, bundleId: `test.${name}`, bundlePath: path.join(temp, `${name}.app`), sdefPath: sdef, explicit: false }] });
    return { summaries, mirrorRoot };
  };
  const calls = async () => (await fs.readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const reset = async () => { await fs.rm(log, { force: true }); await fs.rm(process.env.STATE, { force: true }); };
  const files = async root => { const out = []; const walk = async f => { for (const e of await fs.readdir(f, { withFileTypes: true }).catch(() => [])) { const full = path.join(f, e.name); e.isDirectory() ? await walk(full) : out.push(full); } }; await walk(root); return out; };

  await fs.writeFile(rows, JSON.stringify([{ i: 'c-1', t: 'First card', b: 'classesmarker written body', d: null, c: 'Home' }]));

  // not running: started hidden, read, and left running; never quit
  await reset();
  let result = await readApp('Cardbox', sdefPath);
  assert.deepEqual(await calls(), ['running', 'launch', 'running', 'hide', 'read'], `an app that was not running: ${JSON.stringify(await calls())}`);
  assert.equal(result.summaries[0].status, 'included');
  assert.equal(await fs.readFile(process.env.STATE, 'utf8'), 'on', 'the app DataBrain started stays running');

  // the next check finds it running: no launch, no hide, no quit
  await fs.rm(log, { force: true });
  await readApp('Cardbox', sdefPath);
  assert.deepEqual(await calls(), ['running', 'read'], `a running app is not started again, hidden or quit: ${JSON.stringify(await calls())}`);

  // an app the user started is left exactly as it is
  await reset(); await fs.writeFile(process.env.STATE, 'on');
  await readApp('Cardbox', sdefPath);
  assert.deepEqual(await calls(), ['running', 'read'], `an app that was running is not touched: ${JSON.stringify(await calls())}`);

  // a people app is not read at all: no question, no launch, no prompt
  await reset();
  await fs.writeFile(rows, JSON.stringify([{ i: 'p-1', t: 'Ada Example', b: 'personmarker likes tea', d: null, c: 'Friends' }]));
  result = await readApp('Peoplebox', personSdef);
  assert.deepEqual(await calls(), [], `a people app is never asked anything: ${JSON.stringify(await calls())}`);
  assert.equal(result.summaries[0].status, 'people-events');
  assert.deepEqual(await files(result.mirrorRoot), [], 'nothing of a people app is written');
  assert(readers.appStatusLines({ summaries: result.summaries }).includes('Contacts and calendars are not read, to protect your private information.'), 'status says one plain sentence');
  // names from the dictionary that could carry code: the app is skipped, no script is built, nothing runs
  const evil = 'x;app.doShellScript(&quot;id&quot;);y';
  const attempts = {
    'a flag name': `<class name="card" code="xxxx" plural="cards">${prop('title')}${prop('text')}${prop('id')}<property name="locked;app.doShellScript(&quot;id&quot;)" code="lock" type="boolean"/></class>`,
    'a plural': `<class name="card" code="xxxx" plural="${evil}">${prop('title')}${prop('text')}${prop('id')}</class>`,
    'a class name': `<class name="${evil}" code="xxxx" plural="cards">${prop('title')}${prop('text')}${prop('id')}</class>`,
  };
  for (const [label, xml] of Object.entries(attempts)) {
    const dictionaryPath = path.join(temp, 'E.sdef');
    await fs.writeFile(dictionaryPath, `<dictionary><suite name="S">${xml}</suite></dictionary>`);
    const [description] = readers.findTextClasses(readers.parseSdef(await fs.readFile(dictionaryPath, 'utf8')));
    assert(description, `${label}: the class still qualifies, so the name check is what stops it`);
    assert.equal(readers.descriptionNamesSafe(description), false, `${label}: the names are not accepted`);
    if (label !== 'a class name') assert.throws(() => readers.jxaReadScript('/x.app', description), /unsafe name/, `${label}: no script is built`);   // the class name itself never enters a script, the app is skipped all the same
    await reset();
    await fs.writeFile(rows, JSON.stringify([{ i: 'c-1', t: 'A card', b: 'evilmarker body', d: null, c: 'Home' }]));
    result = await readApp('Evilbox', dictionaryPath);
    assert.deepEqual(await calls(), [], `${label}: nothing was asked of the app or the interpreter: ${JSON.stringify(await calls())}`);
    assert.equal(result.summaries[0].status, 'unsafe-names', `${label}: the app is skipped`);
    assert.deepEqual(await files(result.mirrorRoot), [], `${label}: nothing is written`);
    assert(readers.appStatusLines({ summaries: result.summaries }).some(line => /Evilbox has a scripting dictionary with names DataBrain does not accept, so it is not read\./.test(line)), `${label}: status says why`);
  }
  assert.equal(readers.descriptionNamesSafe(readers.findTextClasses(readers.parseSdef(`<dictionary><suite name="S">${cls('note', ['name', 'plaintext', ['id', 'text'], ['modification date', 'date'], ['password protected', 'boolean']])}</suite></dictionary>`))[0]), true, 'ordinary names are accepted');
  console.log('PASS: only real written bodies are read; apps with people or events in their dictionary are skipped without any question; an app that was not running is started hidden once and left running, one that was running is never touched');
} finally {
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
}
