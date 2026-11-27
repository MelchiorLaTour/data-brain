// 0.2.1 part 2: the double-click installer for ChatGPT, run from the REAL built zip (quarantine flag set on it as a browser would) in a fake HOME.
// Fresh install; the settings file keeps every other byte; a foreign "databrain" entry is refused; a damaged, extended or linked package
// changes nothing; running it again updates and keeps the brain; the installed server starts on its bundled Node exactly as config.toml says.
// Invented data only. Never touches the real ~/.codex or the real home.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHome, startChatgpt } from './chatgpt-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratchTgz = path.join(os.homedir(), 'Claude/databrain_public_release/scratch/node-official/dl/node.tgz');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-installer-test.'));
const out = path.join(work, 'out');
const build = spawnSync('bash', [path.join(root, 'setup/chatgpt/build.sh')], {
  env: { ...process.env, DATABRAIN_PACKAGING_OUT_DIR: out, ...(process.env.DATABRAIN_NODE_TGZ || !existsSync(scratchTgz) ? {} : { DATABRAIN_NODE_TGZ: scratchTgz }) }, encoding: 'utf8',
});
assert.equal(build.status, 0, `build failed: ${build.stdout}\n${build.stderr}`);
assert(/Boot test OK/.test(build.stdout), build.stdout);
const zip = path.join(out, 'DataBrain-ChatGPT-Installer-0.2.1.zip');
const expectedZipSha = readFileSync(`${zip}.sha256`, 'utf8').split(/\s+/)[0];
assert.equal(execFileSync('shasum', ['-a', '256', zip], { encoding: 'utf8' }).split(/\s+/)[0], expectedZipSha, 'the .sha256 file matches the zip');

// a browser download: the zip carries the quarantine flag, and what is unpacked from it carries it too
execFileSync('xattr', ['-w', 'com.apple.quarantine', `0083;${Math.floor(Date.now() / 1000).toString(16)};Safari;`, zip]);
async function unpack(label) {
  const folder = path.join(work, `unpacked-${label}`);
  await fs.mkdir(folder);
  execFileSync('ditto', ['-x', '-k', zip, folder]);
  const top = path.join(folder, 'DataBrain-ChatGPT-Installer-0.2.1');
  execFileSync('xattr', ['-wr', 'com.apple.quarantine', '0083;6ae7cc02;Safari;', top]);
  return top;
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (top, home) => spawnSync(path.join(top, 'Install DataBrain for ChatGPT.command'), [], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: work }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const readRawConfig = home => readFileSync(path.join(home, '.codex/config.toml'), 'utf8');
// Part 25 G: the installer also writes one marked always-on rule block (developer_instructions) before the first table. Every check below is about the databrain
// entry and the user's own lines, so they read the file without that block; the block itself is checked at the end of step 1 and by test_always_on_rule.mjs.
const RULE_BLOCK = /# >>> databrain-managed: developer_instructions[^\n]*\n[^\n]*\n# <<< databrain-managed <<<\n\n?/;
const readConfig = home => readRawConfig(home).replace(RULE_BLOCK, '');
const treeOf = async dir => {
  const found = [];
  const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true })) { const p = path.join(d, e.name); found.push(p); if (e.isDirectory()) await walk(p); } };
  if (existsSync(dir)) await walk(dir);
  return found.sort();
};
const blockFor = home => {
  const dest = `${home}/Library/Application Support/DataBrain/app/0.2.1`;
  return `[mcp_servers.databrain]\ncommand = "${dest}/node/bin/node"\nargs = ["${dest}/setup/mcp/server.mjs", "--databrain-client", "chatgpt"]\nstartup_timeout_sec = 30\ntool_timeout_sec = 1200\n`;
};
const appRootOf = home => path.join(home, 'Library/Application Support/DataBrain/app');
const noBackups = async home => (await fs.readdir(path.join(home, '.codex')).catch(() => [])).filter(name => name.includes('backup'));

try {
  // 1. fresh install, no settings file yet
  let top = await unpack('fresh');
  const fresh = await fakeHome('installer-fresh');
  const first = run(top, fresh.home);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert(/DataBrain for ChatGPT 0\.2\.1 is installed\./.test(first.stdout) && /quit ChatGPT \(Command-Q\)/.test(first.stdout) && /Set up my DataBrain/.test(first.stdout), first.stdout);
  assert(!first.stdout.includes(fresh.home) && !first.stderr.trim(), `plain output, home shown as ~: includesHome=${first.stdout.includes(fresh.home)} stderr=${JSON.stringify(first.stderr)} home=${fresh.home}`);
  assert.equal(readConfig(fresh.home), blockFor(fresh.home), 'the new settings file holds exactly the databrain entry');
  assert.equal((readRawConfig(fresh.home).match(/# >>> databrain-managed: developer_instructions/g) || []).length, 1, 'the always-on rule block is written once');
  assert(/Rule:\s+Always-on rule: written/.test(first.stdout), `the installer says the rule was written:\n${first.stdout}`);
  const dest = path.join(appRootOf(fresh.home), '0.2.1');
  for (const file of ['node/bin/node', 'setup/mcp/server.mjs', 'setup/chatgpt/VERSION', 'BUILDINFO.txt', 'bin/fts.sh']) assert(existsSync(path.join(dest, file)), `${file} installed`);
  assert.equal(execFileSync(path.join(dest, 'node/bin/node'), ['-v'], { encoding: 'utf8' }).trim(), 'v24.22.2');
  assert.deepEqual((await fs.readdir(appRootOf(fresh.home))).sort(), ['0.2.1'], 'no staging leftovers');
  assert(!existsSync(path.join(fresh.home, 'DataBrain')), 'the installer never creates the brain');
  assert.deepEqual(await fs.readdir(fresh.home).then(names => names.sort()), ['.agents', '.codex', 'Documents', 'Library'], 'nothing else appeared in the home folder (Documents is the fake home\'s own empty folder)');

  // 2. the installed server starts exactly the way config.toml says, on its bundled Node
  const config = readConfig(fresh.home);
  const command = config.match(/^command = "(.*)"$/m)[1];
  const args = JSON.parse(config.match(/^args = (\[.*\])$/m)[1]);
  assert.equal(command, path.join(dest, 'node/bin/node'));
  const server = startChatgpt({ home: fresh.home, script: args[0], node: command, extraArgs: args.slice(1) });
  try {
    const init = await server.initialize({ elicitation: { form: {} } });
    assert.equal(init.serverInfo.name, 'databrain');
    assert.equal(init.serverInfo.version, '0.2.1', 'the ChatGPT package reports its own version');
    assert((await server.ask('tools/list', {})).result.tools.length >= 20);
    assert(/Stage: not configured/.test(await server.tool('databrain_setup_status')));
    const verify = await server.tool('databrain_verify_install');
    assert(/(?:PASS|PARTIAL): Package identity — DataBrain for ChatGPT 0\.2\.1; packaged files match their embedded digest/.test(verify), verify);
    assert(!/^FAIL:/m.test(verify), verify);
  } finally { await server.stop(); }
  assert(!existsSync(path.join(fresh.home, 'DataBrain')), 'starting the server does not create the brain either');

  // 3. an existing settings file keeps every other byte: the entry is appended after a blank line
  top = await unpack('append');
  const other = await fakeHome('installer-append');
  const original = '# my settings\nmodel = "x"\n\n[mcp_servers.zorblat]\ncommand = "/bin/echo"\nargs = ["hi"]\n';
  await fs.mkdir(path.join(other.home, '.codex'));
  await fs.writeFile(path.join(other.home, '.codex/config.toml'), original, { mode: 0o600 });
  const appended = run(top, other.home);
  assert.equal(appended.status, 0, appended.stdout + appended.stderr);
  assert.equal(readConfig(other.home), `${original}\n${blockFor(other.home)}`);
  const backups = await noBackups(other.home);
  assert.equal(backups.length, 1, 'one backup of the old file');
  assert.equal(readFileSync(path.join(other.home, '.codex', backups[0]), 'utf8'), original, 'the backup is the old file, byte for byte');
  assert.equal((await fs.stat(path.join(other.home, '.codex/config.toml'))).mode & 0o777, 0o600, 'the file keeps its permissions');
  assert(/saved as ~\/\.codex\/config\.toml\.databrain-backup-/.test(appended.stdout), appended.stdout);

  // 4. running it again: same settings, no second backup, and the brain that exists is untouched
  await fs.mkdir(path.join(other.home, 'DataBrain'));
  await fs.writeFile(path.join(other.home, 'DataBrain', 'marker.txt'), 'my invented brain\n');
  const again = run(top, other.home);
  assert.equal(again.status, 0, again.stdout + again.stderr);
  assert(/already lists DataBrain/.test(again.stdout), again.stdout);
  assert.equal(readConfig(other.home), `${original}\n${blockFor(other.home)}`);
  assert.equal((await noBackups(other.home)).length, 1, 'an unchanged file gets no new backup');
  assert.equal(readFileSync(path.join(other.home, 'DataBrain', 'marker.txt'), 'utf8'), 'my invented brain\n', 'the brain is kept');
  assert.deepEqual(await fs.readdir(path.join(other.home, 'DataBrain')), ['marker.txt']);

  // 5. an older entry of ours (another version folder, more keys, a table and comments after it) is replaced; everything else stays
  const upgrade = await fakeHome('installer-upgrade');
  const oldDest = `${upgrade.home}/Library/Application Support/DataBrain/app/0.2.0`;
  const before = '# top\n\n[mcp_servers.databrain]\ncommand = "' + oldDest + '/node/bin/node"\nargs = ["' + oldDest + '/setup/mcp/server.mjs"]\nenabled = false\n[mcp_servers.databrain.env]\nFOO = "1"\n\n# the other server\n[mcp_servers.zorblat]\ncommand = "/bin/echo"\n';
  await fs.mkdir(path.join(upgrade.home, '.codex'));
  await fs.writeFile(path.join(upgrade.home, '.codex/config.toml'), before);
  const upgraded = run(top, upgrade.home);
  assert.equal(upgraded.status, 0, upgraded.stdout + upgraded.stderr);
  assert.equal(readConfig(upgrade.home), `# top\n\n${blockFor(upgrade.home)}\n# the other server\n[mcp_servers.zorblat]\ncommand = "/bin/echo"\n`, 'only the databrain entry changed');

  // 5b. servers an earlier install left running are stopped; an index worker, another app's server and a stranger are not
  {
    const stale = await fakeHome('installer-stale-servers');
    const appRoot = appRootOf(stale.home);
    await fs.mkdir(path.join(appRoot, '0.2.0/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(appRoot, '0.2.0/node/bin/node'));
    await fs.mkdir(path.join(stale.home, 'elsewhere'), { recursive: true });
    await fs.symlink(process.execPath, path.join(stale.home, 'elsewhere/node'));
    const standIn = (command, ...args) => spawn(command, ['-e', 'setTimeout(() => {}, 120000)', ...args], { stdio: 'ignore' });
    const oldServer = standIn(path.join(appRoot, '0.2.0/node/bin/node'), `${appRoot}/0.2.0/setup/mcp/server.mjs`, '--databrain-client', 'chatgpt');
    const worker = standIn(path.join(appRoot, '0.2.0/node/bin/node'), `${appRoot}/0.2.0/setup/mcp/server.mjs`, '--databrain-run-index-worker');
    const foreignApp = standIn(path.join(stale.home, 'elsewhere/node'), `${stale.home}/elsewhere/setup/mcp/server.mjs`);
    // a DataBrain server of ANOTHER home (as a real user's would be while a test installs into a fake home) must survive
    const otherHome = await fakeHome('installer-other-home');
    const otherApp = appRootOf(otherHome.home);
    await fs.mkdir(path.join(otherApp, '0.2.0/node/bin'), { recursive: true });
    await fs.symlink(process.execPath, path.join(otherApp, '0.2.0/node/bin/node'));
    const bystander = standIn(path.join(otherApp, '0.2.0/node/bin/node'), `${otherApp}/0.2.0/setup/mcp/server.mjs`, '--databrain-client', 'chatgpt');
    const gone = new Promise(resolve => oldServer.on('exit', resolve));
    await sleep(800);
    const result = run(top, stale.home);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert(/Stopped 1 older DataBrain program\(s\)/.test(result.stdout), `the installer says what it stopped:\n${result.stdout}`);
    await Promise.race([gone, sleep(5000)]);
    assert.notEqual(oldServer.exitCode ?? oldServer.signalCode, null, 'the old server was stopped');
    assert.equal(worker.exitCode, null, 'the index worker was left to finish');
    assert.equal(foreignApp.exitCode, null, 'a program outside the DataBrain app folder was left alone');
    assert.equal(bystander.exitCode ?? bystander.signalCode, null, 'a DataBrain server belonging to another home was left alone');
    worker.kill('SIGKILL'); foreignApp.kill('SIGKILL'); bystander.kill('SIGKILL');
  }

  // 6. a databrain entry that points somewhere else is never overwritten: refused, nothing changed
  for (const [label, header, command] of [['plain header', '[mcp_servers.databrain]', '/Applications/DataBrain Codex.app/Contents/MacOS/node'], ['quoted header', '[mcp_servers."databrain"]', '/usr/local/bin/other'], ['indented header', '  [mcp_servers.databrain]', '/usr/local/bin/other']]) {
    const foreign = await fakeHome(`installer-foreign-${label.replace(/\W+/g, '-')}`);
    const text = `[mcp_servers.zorblat]\ncommand = "/bin/echo"\n\n${header}\ncommand = "${command}"\nenabled = false\n`;
    await fs.mkdir(path.join(foreign.home, '.codex'));
    await fs.writeFile(path.join(foreign.home, '.codex/config.toml'), text);
    const refused = run(top, foreign.home);
    assert.equal(refused.status, 1, `${label}: ${refused.stdout}`);
    assert(/different local tool named "databrain"/.test(refused.stdout) && /Nothing on your Mac was changed/.test(refused.stdout), refused.stdout);
    assert.equal(readConfig(foreign.home), text, `${label}: settings untouched`);
    assert.deepEqual(await noBackups(foreign.home), [], `${label}: no backup made`);
    assert(!existsSync(path.join(foreign.home, 'Library')), `${label}: nothing installed`);
  }

  // 7. a damaged, extended or linked package changes nothing
  const damage = {
    'a changed file': async dir => fs.appendFile(path.join(dir, 'payload/setup/mcp/server.mjs'), '\n// changed\n'),
    'a changed Node program': async dir => fs.appendFile(path.join(dir, 'payload/node/bin/node'), 'x'),
    'a file added': async dir => fs.writeFile(path.join(dir, 'payload/extra.txt'), 'added\n'),
    'a file removed': async dir => fs.rm(path.join(dir, 'payload/bin/fts.sh')),
    'a link added': async dir => fs.symlink('/etc/hosts', path.join(dir, 'payload/link')),
    'the checksum list removed': async dir => fs.rm(path.join(dir, 'PAYLOAD.sha256')),
  };
  for (const [label, damageIt] of Object.entries(damage)) {
    const broken = await unpack(`damaged-${label.replace(/\W+/g, '-')}`);
    await damageIt(broken);
    const home = await fakeHome(`installer-damaged-${label.replace(/\W+/g, '-')}`);
    const config = '[mcp_servers.zorblat]\ncommand = "/bin/echo"\n';
    await fs.mkdir(path.join(home.home, '.codex'));
    await fs.writeFile(path.join(home.home, '.codex/config.toml'), config);
    const result = run(broken, home.home);
    assert.equal(result.status, 1, `${label}: ${result.stdout}`);
    assert(/DataBrain was NOT installed/.test(result.stdout) && /Nothing on your Mac was changed/.test(result.stdout), `${label}: ${result.stdout}`);
    assert.equal(readConfig(home.home), config, `${label}: settings untouched`);
    assert(!existsSync(path.join(home.home, 'Library')), `${label}: nothing installed`);
    assert.deepEqual(await noBackups(home.home), [], `${label}: no backup`);
  }

  // 8. the installer reads and writes nothing of the user's: a folder of documents is byte-identical afterwards
  const docs = await fakeHome('installer-docs');
  await fs.mkdir(path.join(docs.home, 'Documents'), { recursive: true });
  await fs.writeFile(path.join(docs.home, 'Documents', 'Private.md'), 'invented private note\n');
  const docsBefore = await treeOf(path.join(docs.home, 'Documents'));
  assert.equal(run(top, docs.home).status, 0);
  assert.deepEqual(await treeOf(path.join(docs.home, 'Documents')), docsBefore);
  assert.equal(readFileSync(path.join(docs.home, 'Documents', 'Private.md'), 'utf8'), 'invented private note\n');
  assert.deepEqual((await fs.readdir(docs.home)).sort(), ['.agents', '.codex', 'Documents', 'Library']);

  console.log('PASS: ChatGPT installer (built zip, quarantined as a download): a fresh install writes only the app folder and one settings entry and never creates the brain; the installed server starts as config.toml says on its bundled Node 24.22.2 and verify finds its identity; an existing settings file keeps every other byte and gets a backup; running again changes nothing and keeps the brain; an older entry of ours is replaced; a foreign "databrain" entry is refused; a changed, extended, shortened or linked package, or a missing checksum list, changes nothing.');
} finally {
  await fs.rm(work, { recursive: true, force: true });
}
