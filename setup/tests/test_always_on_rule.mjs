// Part 25 G: the always-on rule script on fake config files (never the real ~/.codex). Written once, before the first [table], everything else
// byte for byte, TOML still parses, a user's own developer_instructions is left alone, remove undoes exactly the block.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const script = process.env.DATABRAIN_RULE_SCRIPT || path.join(here, '../chatgpt/always-on-rule.sh');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'databrain-rule-'));
const run = (action, config) => spawnSync('bash', [script, action, config], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.join(temp, 'home'), TMPDIR: temp } });
const tomlParses = file => spawnSync('python3', ['-c', 'import sys,tomllib;d=tomllib.load(open(sys.argv[1],"rb"));print(d.get("developer_instructions",""))', file], { encoding: 'utf8' });
const START = '# >>> databrain-managed: developer_instructions';
const ruleText = fs.readFileSync(path.join(path.dirname(script), 'always-on-rule.txt'), 'utf8').trim();
const configs = {
  tables: '# Parity banner\nmodel = "gpt-5"\nsandbox = "workspace-write"\n\n# the server\n[mcp_servers.databrain]\ncommand = "/x/node"\nargs = ["a", "b"]\n\n[mcp_servers.other]\ncommand = "echo"\n',
  notables: '# only keys\nmodel = "gpt-5"\n',
  empty: '',
  multiline: 'notes = """\n[looks like a table]\nbut it is inside a string\n"""\n\n[real]\nx = 1\n',
  nofinalnewline: 'model = "gpt-5"\n[t]\nk = 1',
};
const results = [];
try {
  for (const [name, text] of Object.entries(configs)) {
    const file = path.join(temp, `${name}.toml`);
    fs.writeFileSync(file, text);
    assert.match(run('check', file).stdout, /Always-on rule: missing/, `${name}: check before`);
    const first = run('write', file);
    assert.equal(first.status, 0, `${name}: write ${first.stderr}`);
    const afterFirst = fs.readFileSync(file, 'utf8');
    assert.equal(afterFirst.split(START).length - 1, 1, `${name}: exactly one block`);
    assert.match(run('check', file).stdout, /Always-on rule: present/, `${name}: check after`);
    // idempotent: a second and third write change nothing and make no backup
    const backupsBefore = fs.readdirSync(temp).filter(f => f.includes('.databrain-backup-')).length;
    run('write', file); run('write', file);
    assert.equal(fs.readFileSync(file, 'utf8'), afterFirst, `${name}: reinstall wrote the block again`);
    assert.equal(fs.readdirSync(temp).filter(f => f.includes('.databrain-backup-')).length, backupsBefore, `${name}: a no-change write made a backup`);
    // the block sits before the first [table] header (outside strings)
    const parsed = tomlParses(file);
    assert.equal(parsed.status, 0, `${name}: TOML no longer parses: ${parsed.stderr}`);
    assert.equal(parsed.stdout.trim(), ruleText, `${name}: developer_instructions is not a top-level key with the rule text`);
    // everything else byte for byte: removing the block gives the original file back
    assert.match(run('remove', file).stdout, /removed/, `${name}: remove`);
    assert.equal(fs.readFileSync(file, 'utf8'), text, `${name}: remove did not give back the original bytes`);
    results.push(name);
  }
  // a user's own developer_instructions is never overwritten (exit 3, file untouched); the same key inside a table is not theirs
  const own = path.join(temp, 'own.toml');
  const ownText = 'developer_instructions = "my own rules"\nmodel = "x"\n[t]\nk = 1\n';
  fs.writeFileSync(own, ownText);
  const refused = run('write', own);
  assert.equal(refused.status, 3, 'own developer_instructions: exit 3');
  assert.match(refused.stdout, /NOT written/);
  assert.equal(fs.readFileSync(own, 'utf8'), ownText, 'own developer_instructions: file changed');
  assert.match(run('check', own).stdout, /missing/, 'own developer_instructions: check must say missing');
  const inTable = path.join(temp, 'intable.toml');
  fs.writeFileSync(inTable, 'model = "x"\n[t]\ndeveloper_instructions = "belongs to table t"\n');
  assert.equal(run('write', inTable).status, 0, 'a developer_instructions inside a table is not the user\'s top-level key');
  assert.equal(tomlParses(inTable).stdout.trim(), ruleText);
  // a block with an older text is brought up to date in place (one block, not two)
  const old = path.join(temp, 'old.toml');
  fs.writeFileSync(old, `model = "x"\n${START} (old)\n>>>\ndeveloper_instructions = """old text"""\n# <<< databrain-managed <<<\n\n[t]\nk = 1\n`.replace('\n>>>\n', ' >>>\n'));
  assert.match(run('check', old).stdout, /missing/, 'older text counts as missing');
  assert.equal(run('write', old).status, 0);
  const updated = fs.readFileSync(old, 'utf8');
  assert.equal(updated.split(START).length - 1, 1, 'older block replaced, not duplicated');
  assert.equal(tomlParses(old).stdout.trim(), ruleText);
  // no config file: created with only the block
  const none = path.join(temp, 'sub', 'none.toml');
  assert.equal(run('write', none).status, 0);
  assert.equal(tomlParses(none).stdout.trim(), ruleText);
  // verify_install says so as a plain fact line (ChatGPT host, read only): missing, then present after the script wrote the block, never on Claude
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const verifyLine = async (client, home) => {
    const child = spawn(process.execPath, [path.join(here, '../mcp/server.mjs'), '--databrain-client', client], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: temp }, stdio: ['pipe', 'pipe', 'pipe'] });
    const waiting = new Map(); let n = 0;
    readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
    const ask = (method, params) => new Promise((resolve, reject) => { const id = ++n; const t = setTimeout(() => reject(new Error(`timeout ${method}`)), 30000); waiting.set(id, m => { clearTimeout(t); resolve(m); }); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
    await ask('initialize', { protocolVersion: '2025-03-26' });
    const text = (await ask('tools/call', { name: 'databrain_verify_install', arguments: {} })).result?.content?.[0]?.text ?? '';
    child.kill();
    return text.split('\n').find(line => /^Standing note in ChatGPT's settings:/.test(line)) ?? null;
  };
  const vhome = path.join(temp, 'vhome'); fs.mkdirSync(path.join(vhome, '.codex'), { recursive: true });
  assert.equal(await verifyLine('chatgpt', vhome), "Standing note in ChatGPT's settings: missing", 'verify_install: missing before the block exists');
  assert.equal(run('write', path.join(vhome, '.codex', 'config.toml')).status, 0);
  assert.equal(await verifyLine('chatgpt', vhome), "Standing note in ChatGPT's settings: present", 'verify_install: present after the block was written');
  assert.equal(await verifyLine('claude', vhome), null, 'verify_install: the Claude host has no such line');
  console.log(`always-on rule: PASS (${results.join(', ')}, own key refused, in-table key, older text, no file)`);
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
