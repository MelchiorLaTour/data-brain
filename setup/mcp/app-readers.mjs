// Generic reader for the apps a person writes in. An app is read by HOW IT STORES ITS DATA, never by its name: only scriptable apps are read,
// through their scripting dictionary (sdef): find the classes that carry a title and a real written body, and read them through the app.
// An app without a usable dictionary has nothing DataBrain can read, and status says so; its data folders are never opened.
// Everything becomes plain text files under one folder inside the DataBrain home (the "mirror"), so the existing engine, privacy screen,
// search and refresh work on app content exactly as they do on files. The apps themselves are only ever read, never written.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appPolicy, MESSAGING_SENTENCE, PEOPLE_EVENTS_SENTENCE } from './app-policy.mjs';
import { testHook } from './test-hooks.mjs';

const TITLE_PROPS = ['name', 'title', 'subject', 'summary'];
// A "real written body" is free text the user typed. 'description' is NOT one: in most dictionaries it is metadata (a track, a photo, a filter).
const BODY_PROPS = ['plaintext', 'plain text', 'text', 'content', 'body', 'notes', 'note'];
// Media libraries (tracks, photos, videos) carry these and no written text.
const MEDIA_PROPS = ['duration', 'artist', 'album', 'genre', 'bit rate', 'track number', 'play count', 'video kind', 'media kind'];
const PERSON_CLASS = /\b(?:contact|person|people|attendee)s?\b/i;
const EVENT_CLASS = /\b(?:event|appointment|meeting)s?\b/i;
const PERSON_PROPS = ['first name', 'last name', 'email', 'phone', 'birthday', 'birth date'];
const DATE_PROPS = ['modification date', 'modified', 'last modified', 'modification time'];
const PRIVATE_FLAG = /password protected|protected|locked|encrypted|private/i;
const NOT_CONTENT_CLASSES = new Set(['application', 'window', 'document', 'print settings', 'color', 'rich text', 'attachment']);
const DELETED_CONTAINER = /^(?:recently deleted|deleted|trash|bin)$/i;
const MAX_ITEMS_PER_APP = 20000;

export function applicationDirs() {
  if (testHook('DATABRAIN_TEST_APP_DIRS')) return testHook('DATABRAIN_TEST_APP_DIRS').split(':').filter(Boolean);
  return ['/Applications', '/System/Applications', path.join(os.homedir(), 'Applications')];
}

function real(p) { try { return realpathSync(p); } catch { return null; } }

// A selected folder that IS an Applications folder means "the user's apps", not a document folder: it covers all of them.
export function isApplicationsRoot(root) {
  const target = real(root);
  return !!target && applicationDirs().some(dir => real(dir) === target);
}
export function isAppBundleRoot(root) { return /\.app$/i.test(root); }

function plistOf(bundle) {
  const plist = path.join(bundle, 'Contents', 'Info.plist');
  if (!existsSync(plist)) return null;
  const out = spawnSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', plist], { encoding: 'utf8', timeout: 5000 });
  if (out.status !== 0) return null;
  try { return JSON.parse(out.stdout); } catch { return null; }
}

function sdefOf(bundle, info) {
  const resources = path.join(bundle, 'Contents', 'Resources');
  const named = typeof info.OSAScriptingDefinition === 'string' ? info.OSAScriptingDefinition : null;
  if (named) {
    const file = path.join(resources, /\.sdef$/i.test(named) ? named : `${named}.sdef`);
    if (existsSync(file)) return file;
  }
  try { const found = readdirSync(resources).find(name => /\.sdef$/i.test(name)); if (found) return path.join(resources, found); } catch {}
  return null;
}

// Every .app directly inside the application folders (and one folder level down, for example a utilities folder).
export function discoverApps(dirs = applicationDirs(), explicitBundles = []) {
  const found = new Map();
  const add = (bundle, explicit) => {
    const info = plistOf(bundle);
    if (!info) return;
    const bundleId = info.CFBundleIdentifier || `path:${bundle}`;
    if (found.has(bundleId)) { if (explicit) found.get(bundleId).explicit = true; return; }
    found.set(bundleId, {
      name: info.CFBundleDisplayName || info.CFBundleName || path.basename(bundle, '.app'),
      bundleId, bundlePath: bundle, sdefPath: sdefOf(bundle, info), explicit,
    });
  };
  for (const dir of dirs) {
    let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink?.()) continue;
      const full = path.join(dir, entry.name);
      if (/\.app$/i.test(entry.name)) { add(full, false); continue; }
      let inner; try { inner = readdirSync(full, { withFileTypes: true }); } catch { continue; }
      for (const item of inner) if (item.isDirectory() && /\.app$/i.test(item.name)) add(path.join(full, item.name), false);
    }
  }
  for (const bundle of explicitBundles) add(bundle, true);
  return [...found.values()];
}

// ---- reading a scripting dictionary: just enough XML to find classes, their properties and what they inherit ----
const decode = text => text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
export function parseSdef(xml) {
  const classes = new Map();
  let current = null;
  for (const match of xml.matchAll(/<(\/?)([a-zA-Z-]+)((?:\s+[\w:-]+\s*=\s*"[^"]*")*)\s*(\/?)>/g)) {
    const [, closing, tag, rawAttributes, selfClosing] = match;
    const attributes = {};
    for (const attribute of rawAttributes.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) attributes[attribute[1]] = decode(attribute[2]);
    if (tag === 'class' || tag === 'class-extension') {
      if (closing) { current = null; continue; }
      const name = attributes.name || attributes.extends;
      if (!name) continue;
      current = classes.get(name) || { name, plural: null, inherits: null, properties: [] };
      if (attributes.plural) current.plural = attributes.plural;
      if (attributes.inherits) current.inherits = attributes.inherits;
      classes.set(name, current);
      if (selfClosing) current = null;
    } else if (tag === 'property' && current && !closing && attributes.name) {
      current.properties.push({ name: attributes.name, type: attributes.type || '', access: attributes.access || 'rw' });
    }
  }
  return classes;
}

function allProperties(classes, name, seen = new Set()) {
  const entry = classes.get(name);
  if (!entry || seen.has(name)) return [];
  seen.add(name);
  return [...entry.properties, ...(entry.inherits ? allProperties(classes, entry.inherits, seen) : [])];
}

function classChain(classes, name) {
  const chain = []; const seen = new Set();
  for (let current = name; current && !seen.has(current) && classes.has(current); current = classes.get(current).inherits) { seen.add(current); chain.push(current); }
  return chain;
}

// Classes that describe people or calendar-style events, found from class names and properties, never app names. An app whose dictionary
// has one is not read at all (see exportApps).
function peopleOrEventKind(classes, name) {
  const chain = classChain(classes, name);
  const properties = allProperties(classes, name);
  const has = list => list.some(propertyName => properties.some(property => property.name.toLowerCase() === propertyName));
  if (chain.some(ancestor => PERSON_CLASS.test(ancestor)) || has(PERSON_PROPS)) return 'person';
  if (chain.some(ancestor => EVENT_CLASS.test(ancestor)) || (has(['start date']) && has(['end date', 'allday event', 'attendees']))) return 'event';
  return null;
}
export function hasPeopleOrEvents(classes) {
  for (const name of classes.keys()) {
    if (classChain(classes, name).some(ancestor => NOT_CONTENT_CLASSES.has(ancestor.toLowerCase()))) continue;
    if (peopleOrEventKind(classes, name)) return true;
  }
  return false;
}

// The classes of a dictionary that carry a title and a real written body, and which properties to read for them. A class that is (or
// inherits from) a document or window, that is media (tracks, photos, videos), or that describes people or events yields nothing.
export function findTextClasses(classes) {
  const result = [];
  for (const [name, entry] of classes) {
    const chain = classChain(classes, name);
    if (chain.some(ancestor => NOT_CONTENT_CLASSES.has(ancestor.toLowerCase()))) continue;
    const properties = allProperties(classes, name);
    const has = list => list.some(propertyName => properties.some(property => property.name.toLowerCase() === propertyName));
    const named = list => list.map(propertyName => properties.find(property => property.name.toLowerCase() === propertyName)).find(Boolean);
    if (has(MEDIA_PROPS) || (has(['width']) && has(['height']))) continue;
    if (peopleOrEventKind(classes, name)) continue;
    const title = named(TITLE_PROPS);
    const body = named(BODY_PROPS);
    if (!title || !body || !/^text$|^$/i.test(body.type)) continue;
    result.push({
      className: name,
      plural: entry.plural || `${name}s`,
      title: title.name,
      body: body.name,
      date: named(DATE_PROPS)?.name || null,
      id: properties.find(property => property.name.toLowerCase() === 'id')?.name || null,
      container: properties.find(property => property.name.toLowerCase() === 'container')?.name || null,
      privateFlags: properties.filter(property => /boolean/i.test(property.type) && PRIVATE_FLAG.test(property.name)).map(property => property.name),
      deletedFlag: properties.find(property => property.name.toLowerCase() === 'deleted' && /boolean/i.test(property.type))?.name || null,
    });
  }
  return result.slice(0, 3);
}

// Names from an app's dictionary go into the scripts DataBrain runs, so only plain words are accepted: letters, digits and spaces, starting
// with a letter. An app with any other name in a class DataBrain would read is not read at all.
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9 ]{0,40}$/;
export const descriptionNamesSafe = d => [d.className, d.plural, d.title, d.body, d.date, d.id, d.container, d.deletedFlag, ...(d.privateFlags || [])].every(name => name == null || SAFE_NAME.test(name));
const jxaName = text => {
  if (!SAFE_NAME.test(String(text))) throw new Error('unsafe name in a scripting dictionary');
  return text.trim().split(/\s+/).map((word, index) => index ? word[0].toUpperCase() + word.slice(1) : word).join('');
};

export function jxaReadScript(bundlePath, description) {
  const p = name => jxaName(name);
  const flags = description.privateFlags.map(flag => `read(() => c.${p(flag)}())`);
  return `// full read
const app = Application(${JSON.stringify(bundlePath)});
const c = app.${p(description.plural)};
const read = get => { try { return get(); } catch (e) { return null; } };
const ids = ${description.id ? `read(() => c.${p(description.id)}())` : 'null'};
const t = c.${p(description.title)}();
const b = c.${p(description.body)}();
const d = ${description.date ? `read(() => c.${p(description.date)}())` : 'null'};
// the bulk form c.container.name() answers one name for every item; resolving each container is the form that is right
const k = ${description.container ? `read(() => c.${p(description.container)}().map(x => { try { return x.name(); } catch (e) { return null; } }))` : 'null'};
const x = ${description.deletedFlag ? `read(() => c.${p(description.deletedFlag)}())` : 'null'};
const flags = [${flags.join(', ')}];
JSON.stringify(t.map((title, i) => ({ i: ids ? ids[i] : null, t: title, b: b[i], d: d ? d[i] : null, c: k ? k[i] : null, x: x ? x[i] === true : false, p: flags.some(f => f && f[i] === true) })));`;
}

// Only the ids and modification dates of every item: two bulk questions, no bodies.
export function jxaDatesScript(bundlePath, description) {
  return `// dates only
const app = Application(${JSON.stringify(bundlePath)});
const c = app.${jxaName(description.plural)};
JSON.stringify({ ids: c.${jxaName(description.id)}(), d: c.${jxaName(description.date)}() });`;
}

// The full record of just the listed items, found by id.
export function jxaFetchScript(bundlePath, description, ids) {
  const p = name => jxaName(name);
  const flags = description.privateFlags.map(flag => `read(() => it.${p(flag)}())`);
  return `// fetch by id
const app = Application(${JSON.stringify(bundlePath)});
const c = app.${p(description.plural)};
const read = get => { try { return get(); } catch (e) { return null; } };
const out = [];
for (const id of ${JSON.stringify(ids)}) {
  try {
    const it = c.byId(id);
    out.push({ i: id, t: it.${p(description.title)}(), b: it.${p(description.body)}(), d: read(() => it.${p(description.date)}()),
      c: ${description.container ? `read(() => it.${p(description.container)}().name())` : 'null'},
      x: ${description.deletedFlag ? `read(() => it.${p(description.deletedFlag)}()) === true` : 'false'},
      p: [${flags.join(', ')}].some(f => f === true) });
  } catch (e) {}
}
JSON.stringify(out);`;
}

// One row from the app -> an item to write, or null when the item must be skipped (protected, deleted, empty).
function itemFromRow(row) {
  if (!row || row.p || row.x || typeof row.b !== 'string') return null;
  if (row.c && DELETED_CONTAINER.test(String(row.c))) return null;
  const body = looksLikeHtml(row.b) ? stripHtml(row.b) : row.b.trim();
  if (!body) return null;
  return { id: row.i != null ? String(row.i) : null, container: row.c ? String(row.c) : '', title: String(row.t || '').trim() || 'Untitled', body, date: row.d || null };
}

// Every read of an app runs in its own process group, so the server can stop it when it leaves: it waits on the app, sometimes for minutes,
// and otherwise outlives a server that quit (two reads did, 2026-10-09). The watcher inside the group stops
// it when the server is killed without a chance to clean up; it also ends by itself when the read ends. `exec "$@"` keeps the read's own pid.
export const liveReadGroups = new Set();
const READ_WATCHER = 'P=$PPID; L=$$; ( while kill -0 $P 2>/dev/null && kill -0 $L 2>/dev/null; do sleep 1; done; kill -TERM -- -$L 2>/dev/null ) >/dev/null 2>&1 & exec "$@"';
function spawnGroup(binary, args, stdio) {
  const child = spawn('/bin/bash', ['-c', READ_WATCHER, 'bash', binary, ...args], { stdio, detached: true });
  liveReadGroups.add(child);
  child.once('close', () => {
    if (child.timeoutCleanupPending) child.timeoutClosed = true;
    else liveReadGroups.delete(child);
  });
  return child;
}

function stopReadGroup(child, signal) {
  if (!child.pid) return;
  try { process.kill(-child.pid, signal); } catch {}
}

function runInterpreter(script, limitMs = Number(testHook('DATABRAIN_TEST_APP_TIMEOUT_MS')) || 10 * 60000) {
  const binary = testHook('DATABRAIN_TEST_APP_OSASCRIPT') || '/usr/bin/osascript';
  return new Promise(resolve => {
    const child = spawnGroup(binary, ['-l', 'JavaScript', '-e', script], ['ignore', 'pipe', 'pipe']);
    let stdout = ''; let stderr = ''; let timedOut = false; let settled = false; let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.timeoutCleanupPending = true;
      stopReadGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        stopReadGroup(child, 'SIGKILL');
        child.timeoutCleanupPending = false;
        if (child.timeoutClosed) liveReadGroups.delete(child);
        finish({ ok: false, stderr: stderr || 'timed out', stdout });
      }, 250);
    }, limitMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', part => { stdout += part; });
    child.stderr.on('data', part => { if (stderr.length < 4000) stderr += part; });
    child.on('error', () => finish({ ok: false, stderr: 'could not start', stdout: '' }));
    child.on('close', code => {
      if (timedOut) return;
      finish({ ok: code === 0, stderr, stdout });
    });
  });
}

const stripHtml = html => decode(html.replace(/<(?:br|\/p|\/div|\/li|\/h\d)\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).replace(/\n{3,}/g, '\n\n').trim();
const looksLikeHtml = text => /<\/?(?:div|p|br|span|html|body|h\d|li|ul|ol|b|i)\b/i.test(text);

// ---- apps DataBrain needs are started once, hidden, and then left running ----
// An app that was not running is started with `open -g -j` and hidden right away, and stays running, so the next check finds it already
// there and never launches it again. An app the user started is never hidden or quit, and neither is one the user brings forward later.
// Asking whether an app runs uses the system's own process list (no Apple event, so no permission prompt).
// With a test interpreter set and no DATABRAIN_TEST_APP_LIFECYCLE stub, every app counts as already running and is never launched.
const runningScript = bundleId => `// running check
ObjC.import('AppKit');
JSON.stringify(ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)})).length > 0);`;
const hideScript = bundleId => `// hide
ObjC.import('AppKit');
const apps = ObjC.unwrap($.NSRunningApplication.runningApplicationsWithBundleIdentifier(${JSON.stringify(bundleId)}));
apps.forEach(a => a.hide);   // in JXA a method without arguments runs when it is read
JSON.stringify(apps.length);`;

function runTool(binary, args, timeoutMs = 20000) {
  return new Promise(resolve => {
    const child = spawnGroup(binary, args, ['ignore', 'pipe', 'ignore']);
    let stdout = ''; let timedOut = false; let settled = false; let killTimer;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(killTimer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.timeoutCleanupPending = true;
      stopReadGroup(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        stopReadGroup(child, 'SIGKILL');
        child.timeoutCleanupPending = false;
        if (child.timeoutClosed) liveReadGroups.delete(child);
        finish({ ok: false, stdout });
      }, 250);
    }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', part => { stdout += part; });
    child.on('error', () => finish({ ok: false, stdout: '' }));
    child.on('close', code => {
      if (timedOut) return;
      finish({ ok: code === 0, stdout });
    });
  });
}
async function lifecycle(action, app) {
  const stub = testHook('DATABRAIN_TEST_APP_LIFECYCLE');
  if (stub) return runTool(stub, [action, app.bundleId || '', app.bundlePath || '']);
  if (testHook('DATABRAIN_TEST_APP_OSASCRIPT')) return { ok: true, stdout: action === 'running' ? 'true' : '' };
  if (action === 'launch') return runTool('/usr/bin/open', ['-g', '-j', '-a', app.bundlePath]);
  return runTool('/usr/bin/osascript', ['-l', 'JavaScript', '-e', (action === 'running' ? runningScript : hideScript)(app.bundleId)]);
}
const lifecycleFailure = result => ({ ok: false, stderr: 'app lifecycle action failed', stdout: result.stdout || '' });
const runningState = result => result.stdout.trim() === 'true' ? true : result.stdout.trim() === 'false' ? false : null;
const isRunning = async app => {
  const result = await lifecycle('running', app);
  return result.ok && runningState(result) === true;
};

// A session starts the app lazily, on the first question that really goes to it, and only if it is not running yet.
export async function withBackgroundApp(app, work) {
  let checked = false;
  let checkFailure = null;
  const session = {
    launchMs: 0,   // time spent starting the app because it was not running (0 when it already was): lets the log tell a cold start from a slow question
    run: async script => {
      if (checkFailure) return checkFailure;
      if (!checked) {
        checked = true;
        if (app.bundleId) {
          const initialCheck = await lifecycle('running', app);
          if (!initialCheck.ok) { checkFailure = lifecycleFailure(initialCheck); return checkFailure; }
          const initialState = runningState(initialCheck);
          if (initialState === null) { checkFailure = lifecycleFailure(initialCheck); return checkFailure; }
          if (initialState) return runInterpreter(script);
          const launchStartedAt = Date.now();
          const launched = await lifecycle('launch', app);
          if (!launched.ok) { checkFailure = lifecycleFailure(launched); return checkFailure; }
          let running = false;
          for (let i = 0; i < 40; i++) {
            const check = await lifecycle('running', app);
            if (!check.ok) { checkFailure = lifecycleFailure(check); return checkFailure; }
            const state = runningState(check);
            if (state === null) { checkFailure = lifecycleFailure(check); return checkFailure; }
            if (state) { running = true; break; }
            await new Promise(resolve => setTimeout(resolve, 500));
          }
          if (!running) { checkFailure = { ok: false, stderr: 'app did not start', stdout: '' }; return checkFailure; }
          const hidden = await lifecycle('hide', app);   // only the app DataBrain just started: some apps open a window even when started hidden
          if (!hidden.ok) { checkFailure = lifecycleFailure(hidden); return checkFailure; }
          session.launchMs = Date.now() - launchStartedAt;
        }
      }
      return runInterpreter(script);
    },
  };
  return work(session);
}

// -> { items: [{id, container, title, body, date}], known: [{i, d}], description, denied, failed }
// `known` lists EVERY item the app reported (also the skipped ones), so a later check can tell new from unchanged.
async function readScriptable(app, session) {
  let xml;
  try { xml = await fs.readFile(app.sdefPath, 'utf8'); } catch { return { items: [], failed: true }; }
  const descriptions = findTextClasses(parseSdef(xml));
  if (!descriptions.every(descriptionNamesSafe)) return { items: [], failed: true };
  if (!descriptions.length) return { items: [], failed: false, noText: true };
  const items = []; const known = [];
  let denied = false; let anyRead = false;
  for (const description of descriptions) {
    const run = await session.run(jxaReadScript(app.bundlePath, description));
    if (!run.ok) { if (/-1743|not authori[sz]ed|not allowed/i.test(run.stderr)) denied = true; continue; }
    let rows; try { rows = JSON.parse(run.stdout.trim()); } catch { continue; }
    anyRead = true;
    for (const row of rows) {
      if (row && row.i != null) known.push({ i: String(row.i), d: row.d == null ? null : String(row.d) });
      const item = itemFromRow(row);
      if (!item) continue;
      items.push(item);
      if (items.length >= MAX_ITEMS_PER_APP) break;
    }
  }
  return { items, known, description: descriptions.length === 1 ? descriptions[0] : null, denied: denied && !anyRead, failed: !anyRead && !denied };
}

// ---- the mirror: one plain text file per item, under <mirror>/<App>/<container>/<title> [id].md ----
const safe = text => String(text).replace(/[\u0000-\u001f/\\]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').slice(0, 120) || 'Untitled';
const shortId = value => createHash('sha256').update(value).digest('hex').slice(0, 6);

// An item that has an id keeps one file name whatever its title or folder becomes; one without an id is named from its place.
function mirrorFileFor(mirrorRoot, app, item, index = 0) {
  const folder = path.join(mirrorRoot, safe(app.name), safe(item.container || '(no folder)'));
  const id = item.id != null ? `id:${item.id}` : `${item.container}\n${item.title}\n${index}`;
  return path.join(folder, `${safe(item.title)} [${shortId(`${app.bundleId}\n${id}`)}].md`);
}

// New text goes in under a hidden name with its date already set, then is renamed into place. Written in place and dated afterwards, the file
// had two different fingerprints for a moment, and an index build that read it in that moment failed its "source changed during read" check
// (seen under load on 2026-10-11). The name does not end in .md, so nothing indexes the half-written file.
export async function writeMirrorFile(file, text, when) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = path.join(path.dirname(file), `.${path.basename(file)}.writing`);
  try {
    await fs.writeFile(staged, text, { mode: 0o600 });
    if (when && !Number.isNaN(when.getTime())) await fs.utimes(staged, when, when);
    await fs.rename(staged, file);
  } catch (error) { await fs.unlink(staged).catch(() => {}); throw error; }
}

async function writeItemFile(file, item) {
  const text = `# ${item.title}\n\n${item.body}\n`;
  let same = false;
  try { same = (await fs.readFile(file, 'utf8')) === text; } catch {}
  const when = item.date ? new Date(item.date) : null;
  if (!same) await writeMirrorFile(file, text, when);
  else if (when && !Number.isNaN(when.getTime())) await fs.utimes(file, when, when).catch(() => {});
  return !same;
}

async function writeMirror(mirrorRoot, app, items) {
  const appDir = path.join(mirrorRoot, safe(app.name));
  const desired = new Map();
  const seen = new Map();
  for (const item of [...items].sort((a, b) => (a.container + a.title + a.body).localeCompare(b.container + b.title + b.body))) {
    const key = `${item.container}\n${item.title}`;
    const index = seen.get(key) || 0; seen.set(key, index + 1);
    desired.set(mirrorFileFor(mirrorRoot, app, item, index), item);
  }
  let written = 0;
  for (const [file, item] of desired) {
    const text = `# ${item.title}\n\n${item.body}\n`;
    let same = false;
    try { same = (await fs.readFile(file, 'utf8')) === text; } catch {}
    const when = item.date ? new Date(item.date) : null;
    if (!same) {
      await writeMirrorFile(file, text, when);
      written += 1;
    }
    // Only when the time differs: setting it again, even to the same value, changes the file's change time, and then every app file would
    // look edited after each restart and be indexed again.
    if (when && !Number.isNaN(when.getTime()) && Math.abs((await fs.stat(file).then(info => info.mtimeMs, () => 0)) - when.getTime()) >= 1) await fs.utimes(file, when, when).catch(() => {});
  }
  // items edited or deleted in the app disappear from the mirror
  const walk = async folder => {
    let entries; try { entries = await fs.readdir(folder, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) { await walk(full); if (!(await fs.readdir(full).catch(() => ['x'])).length) await fs.rmdir(full).catch(() => {}); }
      else if (!desired.has(full)) await fs.unlink(full).catch(() => {});
    }
  };
  await walk(appDir);
  if (!desired.size) await fs.rm(appDir, { recursive: true, force: true });
  const files = new Map([...desired].filter(([, item]) => item.id != null).map(([file, item]) => [item.id, file]));
  return { count: desired.size, written, files };
}

// Reads every app the selection covers and refreshes the mirror. Returns one summary per app: counts only, never item names.
//   status: included | never | messages | people-events | unsafe-names | nothing-readable | denied | online-only
export async function exportApps({ roots, mirrorRoot, manifestDir = null, apps: given = null }) {
  const covering = roots.some(isApplicationsRoot);
  const explicit = roots.filter(isAppBundleRoot);
  const apps = given || discoverApps(covering ? applicationDirs() : [], explicit);
  const summaries = [];
  await fs.mkdir(mirrorRoot, { recursive: true, mode: 0o700 });
  for (const app of apps) {
    const policy = appPolicy(app);
    if (policy !== 'ok') { await writeMirror(mirrorRoot, app, []); summaries.push({ name: app.name, bundleId: app.bundleId, status: policy, items: 0 }); continue; }
    // No dictionary, or none with a class that carries a written body: nothing DataBrain can read (the app's data folders are never opened).
    const nothing = async () => { await writeMirror(mirrorRoot, app, []); summaries.push({ name: app.name, bundleId: app.bundleId, status: 'nothing-readable', items: 0 }); };
    if (!app.sdefPath) { await nothing(); continue; }
    {
      // An app whose dictionary has people or events is not read at all: no question to the app, so no permission prompt for it.
      let xml = ''; try { xml = await fs.readFile(app.sdefPath, 'utf8'); } catch {}
      const classes = parseSdef(xml);
      if (hasPeopleOrEvents(classes)) { await writeMirror(mirrorRoot, app, []); summaries.push({ name: app.name, bundleId: app.bundleId, status: 'people-events', items: 0 }); continue; }
      // names from the dictionary end up inside scripts: any name that is not plain words means the app is not read, 
      const usable = findTextClasses(classes);
      if (!usable.every(descriptionNamesSafe)) { await writeMirror(mirrorRoot, app, []); summaries.push({ name: app.name, bundleId: app.bundleId, status: 'unsafe-names', items: 0 }); continue; }
      if (!usable.length) { await nothing(); continue; }
    }
    let result = { items: [], denied: false };
    let how = null;
    const scripted = await withBackgroundApp(app, session => readScriptable(app, session));
    if (scripted.items.length || scripted.denied) { result = scripted; how = 'dictionary'; }
    const written = await writeMirror(mirrorRoot, app, result.items);
    // What this read saw, item by item (id, modification date, file): the next check asks the app for dates only and compares.
    if (manifestDir) {
      if (how === 'dictionary' && result.description?.id && result.description?.date && result.known?.length) {
        const items = {};
        for (const entry of result.known) items[entry.i] = { modified: entry.d, file: written.files.get(entry.i) || null };
        await fs.mkdir(manifestDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(manifestFile(manifestDir, app), JSON.stringify({ version: 1, className: result.description.className, items }), { mode: 0o600 });
      } else await fs.unlink(manifestFile(manifestDir, app)).catch(() => {});
    }
    summaries.push({ name: app.name, bundleId: app.bundleId, bundlePath: app.bundlePath, sdefPath: app.sdefPath, explicit: !!app.explicit, status: result.denied ? 'denied' : result.items.length ? 'included' : 'online-only', items: written.count, how, readAt: Date.now() });
  }
  // an app that is gone, or no longer covered, leaves nothing behind
  if (!given) {
    const known = new Set(apps.map(app => safe(app.name)));
    for (const entry of await fs.readdir(mirrorRoot).catch(() => [])) if (!known.has(entry)) await fs.rm(path.join(mirrorRoot, entry), { recursive: true, force: true });
  }
  return { summaries, mirrorRoot, at: new Date().toISOString() };
}

async function dropItemFile(file, mirrorRoot) {
  await fs.unlink(file).catch(() => {});
  for (let folder = path.dirname(file); folder.startsWith(`${mirrorRoot}${path.sep}`) && folder !== mirrorRoot; folder = path.dirname(folder)) {
    if ((await fs.readdir(folder).catch(() => ['x'])).length) break;
    await fs.rmdir(folder).catch(() => {});
  }
}

const manifestFile = (dir, app) => path.join(dir, `${safe(app.bundleId)}.json`);
const INCREMENTAL_MAX = 50;

// Asks a scriptable app only for the modification dates of its items (no bodies), compares them with the last read, fetches bodies only for
// new or changed items and drops deleted ones. Generic: the class, id and date property names all come from the scripting dictionary.
// outcome: unchanged | updated | full-needed (no record of a last read, or too much changed) | unsupported (the dictionary has no id or
// date to compare) | denied | failed.
export const updateScriptable = args => withBackgroundApp(args.app, session => updateScriptableIn(args, session));
async function updateScriptableIn({ app, mirrorRoot, manifestDir }, session) {
  let xml;
  try { xml = await fs.readFile(app.sdefPath, 'utf8'); } catch { return { outcome: 'failed' }; }
  const descriptions = findTextClasses(parseSdef(xml));
  if (!descriptions.every(descriptionNamesSafe)) return { outcome: 'failed' };
  const description = descriptions.length === 1 ? descriptions[0] : null;
  if (!description || !description.id || !description.date) return { outcome: 'unsupported' };   // nothing to compare: never has a record
  let manifest;
  try { manifest = JSON.parse(await fs.readFile(manifestFile(manifestDir, app), 'utf8')); } catch { return { outcome: 'full-needed' }; }
  if (manifest.className !== description.className) return { outcome: 'full-needed' };
  const askStartedAt = Date.now();
  const asked = await session.run(jxaDatesScript(app.bundlePath, description));
  const timing = { askMs: Date.now() - askStartedAt - session.launchMs, launchMs: session.launchMs };
  if (!asked.ok) return { outcome: /-1743|not authori[sz]ed|not allowed/i.test(asked.stderr) ? 'denied' : 'failed' };
  let current;
  try { current = JSON.parse(asked.stdout.trim()); } catch { return { outcome: 'failed' }; }
  if (!Array.isArray(current.ids) || !Array.isArray(current.d) || current.ids.length !== current.d.length) return { outcome: 'failed' };
  const now = new Map(current.ids.map((id, index) => [String(id), { raw: id, modified: current.d[index] == null ? null : String(current.d[index]) }]));
  const toFetch = [...now].filter(([id, entry]) => !manifest.items[id] || manifest.items[id].modified !== entry.modified).map(([id]) => id);
  const removed = Object.keys(manifest.items).filter(id => !now.has(id));
  if (!toFetch.length && !removed.length) return { outcome: 'unchanged', checked: now.size, ...timing };
  if (toFetch.length > INCREMENTAL_MAX) return { outcome: 'full-needed' };
  let rows = [];
  if (toFetch.length) {
    const fetched = await session.run(jxaFetchScript(app.bundlePath, description, toFetch.map(id => now.get(id).raw)));
    if (!fetched.ok) return { outcome: 'failed' };
    try { rows = JSON.parse(fetched.stdout.trim()); } catch { return { outcome: 'failed' }; }
  }
  const byId = new Map(rows.map(row => [String(row.i), row]));
  for (const id of removed) { if (manifest.items[id]?.file) await dropItemFile(manifest.items[id].file, mirrorRoot); delete manifest.items[id]; }
  let written = 0;
  for (const id of toFetch) {
    const row = byId.get(id);
    if (!row) continue;   // gone between the two questions: the next check sees it as deleted
    const item = itemFromRow(row);
    const old = manifest.items[id];
    const file = item ? mirrorFileFor(mirrorRoot, app, item) : null;
    if (old?.file && old.file !== file) await dropItemFile(old.file, mirrorRoot);   // edited, moved to another folder, or now skipped
    if (item && await writeItemFile(file, item)) written += 1;
    manifest.items[id] = { modified: now.get(id).modified, file };
  }
  await fs.writeFile(manifestFile(manifestDir, app), JSON.stringify(manifest), { mode: 0o600 });
  return { outcome: 'updated', checked: now.size, fetched: toFetch.length, removed: removed.length, written, ...timing };
}

// The current state of ONE app item, asked of the app by its id (not the dates of every item, not the other bodies). Used when an item is
// opened: if the app's own modification date is newer than the one recorded at the last read, the live text is returned instead of the
// indexed one. An app that is not running is never started for this. -> { outcome, text? }
//   same | changed (text = "# title\n\nbody\n") | gone (deleted, protected or empty now) | unknown (cannot tell: no record, app not running,
//   no answer within limitMs, app said no)
export async function readLiveItem({ summaries, mirrorRoot, manifestDir, file, limitMs = 4000 }) {
  const unknown = { outcome: 'unknown' };
  try {
    const appName = path.relative(mirrorRoot, file).split(path.sep)[0];
    const app = summaries.find(summary => summary.status === 'included' && summary.bundlePath && summary.sdefPath && safe(summary.name) === appName);
    if (!app || !manifestDir) return unknown;
    const descriptions = findTextClasses(parseSdef(await fs.readFile(app.sdefPath, 'utf8')));
    if (descriptions.length !== 1 || !descriptions.every(descriptionNamesSafe) || !descriptions[0].id || !descriptions[0].date) return unknown;
    const manifest = JSON.parse(await fs.readFile(manifestFile(manifestDir, app), 'utf8'));
    const id = Object.keys(manifest.items).find(key => manifest.items[key].file === file);
    if (id === undefined || manifest.className !== descriptions[0].className) return unknown;
    if (!(await isRunning(app))) return unknown;
    const asked = await runInterpreter(jxaFetchScript(app.bundlePath, descriptions[0], [id]), limitMs);
    if (!asked.ok) return unknown;
    const rows = JSON.parse(asked.stdout.trim());
    const row = Array.isArray(rows) ? rows.find(candidate => String(candidate.i) === id) : null;
    if (!row) return { outcome: 'gone' };
    const item = itemFromRow(row);
    if (!item) return { outcome: 'gone' };
    const modified = row.d == null ? null : String(row.d);
    if (modified === manifest.items[id].modified) return { outcome: 'same' };
    return { outcome: 'changed', text: `# ${item.title}\n\n${item.body}\n` };
  } catch { return unknown; }
}

// How many items an app has in the mirror right now (after the privacy screen removed the held ones).
export async function countMirrorItems(mirrorRoot, appName) {
  let count = 0;
  const walk = async folder => {
    for (const entry of await fs.readdir(folder, { withFileTypes: true }).catch(() => [])) {
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) await walk(full); else if (entry.isFile() && !entry.name.startsWith('.')) count += 1;   // a hidden .writing file is a page being written
    }
  };
  await walk(path.join(mirrorRoot, safe(appName)));
  return count;
}

// "<App> > <container> > <title>" for a path inside the mirror (null for any other path).
export function mirrorLabel(file, mirrorRoot) {
  if (!mirrorRoot || !file.startsWith(`${mirrorRoot}${path.sep}`)) return null;
  const parts = path.relative(mirrorRoot, file).split(path.sep);
  if (parts.length < 2) return null;
  const title = parts.pop().replace(/\s\[[0-9a-f]{6}\]\.md$/, '').replace(/\.md$/, '');
  const [appName, ...containers] = parts;
  return [appName, ...containers.filter(name => name !== '(no folder)'), title].join(' > ');
}

function sentenceList(names) {
  const shown = names.slice(0, 12);
  const extra = names.length - shown.length;
  const list = shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : shown[0];
  return extra > 0 ? `${shown.join(', ')} and ${extra} more` : list;
}

// Plain-language status lines from the saved summaries. Counts only: item names never appear.
export function appStatusLines(report) {
  if (!report?.summaries?.length) return [];
  const by = status => report.summaries.filter(summary => summary.status === status);
  const lines = [];
  const included = by('included');
  lines.push(`Apps: ${report.summaries.length} found in the Applications folder; ${included.length} included.`);
  if (included.length) lines.push(`Included apps: ${included.map(app => `${app.name} (${app.items} item${app.items === 1 ? '' : 's'})`).join(', ')}.`);
  const never = by('never');
  if (never.length) lines.push(`Never read: ${sentenceList(never.map(app => app.name))} (password managers, Keychain, Passwords and Wallet are never read, even if added).`);
  if (by('messages').length) lines.push(MESSAGING_SENTENCE);
  if (by('people-events').length) lines.push(PEOPLE_EVENTS_SENTENCE);
  const unsafe = by('unsafe-names');
  if (unsafe.length) lines.push(`${sentenceList(unsafe.map(app => app.name))} ${unsafe.length === 1 ? 'has' : 'have'} a scripting dictionary with names DataBrain does not accept, so ${unsafe.length === 1 ? 'it is' : 'they are'} not read.`);
  for (const app of by('denied')) lines.push(`${app.name} could not be read: macOS did not allow DataBrain to control it. To allow it, open System Settings > Privacy & Security > Automation, switch on ${app.name} under Claude, then ask for a refresh.`);
  const nothing = by('nothing-readable');
  if (nothing.length) lines.push(`${sentenceList(nothing.map(app => app.name))} ${nothing.length === 1 ? 'has' : 'have'} nothing DataBrain can read.`);
  const online = by('online-only');
  if (online.length) lines.push(`${sentenceList(online.map(app => app.name))} ${online.length === 1 ? 'keeps its content online or in a format' : 'keep their content online or in a format'} DataBrain can't read yet.`);
  return lines;
}
