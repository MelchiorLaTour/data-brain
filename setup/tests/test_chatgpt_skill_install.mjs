// Part 20 B (0.2.1): the installer adds ~/.agents/skills/databrain-save-note/SKILL.md (ChatGPT build only); it never overwrites a folder of that name that DataBrain did
// not create; reinstalling replaces only that folder and is idempotent; "Uninstall DataBrain for ChatGPT" removes the skill, DataBrain's own settings entry and this
// version's copy and nothing else. Real built zip, fake HOME, invented data. Never touches the real ~/.agents, ~/.codex or home.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fakeHome } from './chatgpt-harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratchTgz = path.join(os.homedir(), 'Claude/databrain_public_release/scratch/node-official/dl/node.tgz');
const work = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-skill-test.'));
const out = path.join(work, 'out');
const build = spawnSync('bash', [path.join(root, 'setup/chatgpt/build.sh')], { env: { ...process.env, DATABRAIN_PACKAGING_OUT_DIR: out, ...(process.env.DATABRAIN_NODE_TGZ || !existsSync(scratchTgz) ? {} : { DATABRAIN_NODE_TGZ: scratchTgz }) }, encoding: 'utf8' });
assert.equal(build.status, 0, `build failed: ${build.stdout}\n${build.stderr}`);
const zip = path.join(out, 'DataBrain-ChatGPT-Installer-0.2.1.zip');
async function unpack(label) {
  const folder = path.join(work, `unpacked-${label}`); await fs.mkdir(folder);
  execFileSync('ditto', ['-x', '-k', zip, folder]);
  return path.join(folder, 'DataBrain-ChatGPT-Installer-0.2.1');
}
const runIn = (top, name, home) => spawnSync(path.join(top, name), [], { env: { PATH: process.env.PATH, HOME: home, TMPDIR: work }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const install = (top, home) => runIn(top, 'Install DataBrain for ChatGPT.command', home);
const uninstall = (top, home) => runIn(top, 'Uninstall DataBrain for ChatGPT.command', home);
const SOURCE = readFileSync(path.join(root, 'setup/chatgpt/skills/databrain-save-note/SKILL.md'), 'utf8');
const skillDir = home => path.join(home, '.agents/skills/databrain-save-note');
const listAgents = async home => { const found = []; const walk = async d => { for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, e.name); found.push(path.relative(home, p)); if (e.isDirectory()) await walk(p); } }; await walk(path.join(home, '.agents')); return found.sort(); };

try {
  const top = await unpack('a');
  assert(existsSync(path.join(top, 'Uninstall DataBrain for ChatGPT.command')), 'the package carries the uninstaller next to the installer');

  // 1. fresh install: the skill is there with the shipped text, nothing else is in ~/.agents, the output says so in one plain line
  const fresh = await fakeHome('skill-fresh');
  const first = install(top, fresh.home);
  assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`);
  assert.equal(readFileSync(path.join(skillDir(fresh.home), 'SKILL.md'), 'utf8'), SOURCE, 'the installed SKILL.md is the shipped text');
  assert.deepEqual(await listAgents(fresh.home), ['.agents/skills', '.agents/skills/databrain-save-note', '.agents/skills/databrain-save-note/SKILL.md'], 'only the skill appeared in ~/.agents (no staging leftovers)');
  assert(/Skill:\s+added ~\/\.agents\/skills\/databrain-save-note \(it tells ChatGPT to save notes through DataBrain; "Uninstall DataBrain for ChatGPT" removes it\)/.test(first.stdout), `the installer says in one line that the skill was added and where:\n${first.stdout}`);
  assert((d => d && d[1].length <= 120 && /^Save a note/.test(d[1]) && /"save a note"/.test(d[1]) && /"remember this"/.test(d[1]) && /"write this down"/.test(d[1]))(SOURCE.match(/^---\nname: databrain-save-note\ndescription: (.*)\n---/)) && /databrain_capture/.test(SOURCE) && /Saved to:/.test(SOURCE) && /where to save/i.test(SOURCE), 'the skill names its triggers, asks where, calls databrain_capture and reports the place');

  // 2. reinstall: our skill (even edited, marker kept) is replaced by the shipped text; running again changes nothing
  await fs.writeFile(path.join(skillDir(fresh.home), 'SKILL.md'), `${SOURCE}\nlocal edit\n`);
  const second = install(top, fresh.home);
  assert.equal(second.status, 0, `${second.stdout}\n${second.stderr}`);
  assert(/Skill:\s+updated /.test(second.stdout), 'a reinstall says updated');
  assert.equal(readFileSync(path.join(skillDir(fresh.home), 'SKILL.md'), 'utf8'), SOURCE, 'the reinstall restores the shipped text');
  const third = install(top, fresh.home);
  assert.equal(third.status, 0);
  assert.equal(readFileSync(path.join(skillDir(fresh.home), 'SKILL.md'), 'utf8'), SOURCE, 'a third run is idempotent');
  assert.deepEqual(await listAgents(fresh.home), ['.agents/skills', '.agents/skills/databrain-save-note', '.agents/skills/databrain-save-note/SKILL.md'], 'no leftovers after reinstalling');

  // 3. a folder of that name that is not ours is never touched, and nothing else is changed either
  for (const [label, prepare] of [
    ['no marker', async dir => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'SKILL.md'), '---\nname: databrain-save-note\ndescription: mine\n---\nmy own skill\n'); }],
    ['marker but an extra file', async dir => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'SKILL.md'), SOURCE); await fs.writeFile(path.join(dir, 'notes.txt'), 'extra'); }],
    ['a link', async dir => { const target = path.join(path.dirname(dir), 'elsewhere'); await fs.mkdir(target, { recursive: true }); await fs.writeFile(path.join(target, 'SKILL.md'), SOURCE); await fs.symlink(target, dir); }],
  ]) {
    const foreign = await fakeHome(`skill-foreign-${label.replace(/\W/g, '')}`);
    await prepare(skillDir(foreign.home));
    const before = (await listAgents(foreign.home)).join('|'); const contentBefore = existsSync(path.join(skillDir(foreign.home), 'SKILL.md')) ? readFileSync(path.join(skillDir(foreign.home), 'SKILL.md'), 'utf8') : '';
    const refused = install(top, foreign.home);
    assert.notEqual(refused.status, 0, `${label}: the installer stops`);
    assert(/did not create, and DataBrain will not overwrite it/.test(refused.stdout) && /Nothing on your Mac was changed/.test(refused.stdout), `${label}: it says so plainly:\n${refused.stdout}`);
    assert.equal((await listAgents(foreign.home)).join('|'), before, `${label}: the folder is untouched`);
    assert.equal(existsSync(path.join(skillDir(foreign.home), 'SKILL.md')) ? readFileSync(path.join(skillDir(foreign.home), 'SKILL.md'), 'utf8') : '', contentBefore, `${label}: its file is untouched`);
    assert(!existsSync(path.join(foreign.home, '.codex/config.toml')) && !existsSync(path.join(foreign.home, 'Library/Application Support/DataBrain')), `${label}: DataBrain itself was not installed either`);
    const unin = uninstall(top, foreign.home);
    assert.equal(unin.status, 0);
    assert(/was not created by DataBrain, so it was left alone/.test(unin.stdout), `${label}: the uninstaller leaves it too`);
    assert.equal((await listAgents(foreign.home)).join('|'), before, `${label}: still untouched after the uninstaller`);
  }

  // 4. uninstall: the skill, DataBrain's own settings entry and this version's copy go; every other byte of the settings file, other skills and the brain stay
  const home2 = await fakeHome('skill-uninstall');
  await fs.mkdir(path.join(home2.home, '.codex'), { recursive: true });
  const otherConfig = '[mcp_servers.other]\ncommand = "/bin/true"\n\n[features]\nmemories = true\n';
  await fs.writeFile(path.join(home2.home, '.codex/config.toml'), otherConfig);
  await fs.mkdir(path.join(home2.home, '.agents/skills/someone-elses'), { recursive: true });
  await fs.writeFile(path.join(home2.home, '.agents/skills/someone-elses/SKILL.md'), 'not ours\n');
  await fs.mkdir(path.join(home2.home, 'DataBrain/moc'), { recursive: true });
  await fs.writeFile(path.join(home2.home, 'DataBrain/moc/index.tsv'), 'kept\n');
  assert.equal(install(top, home2.home).status, 0);
  assert(/\[mcp_servers\.databrain\]/.test(readFileSync(path.join(home2.home, '.codex/config.toml'), 'utf8')), 'installed');
  const installedConfig = readFileSync(path.join(home2.home, '.codex/config.toml'), 'utf8');
  assert(installedConfig.indexOf('# >>> databrain-managed: developer_instructions') >= 0 && installedConfig.indexOf('# >>> databrain-managed: developer_instructions') < installedConfig.indexOf('[mcp_servers.other]'), 'the always-on rule block is in the file, before the first table');
  const removed = uninstall(top, home2.home);
  assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
  assert(!existsSync(skillDir(home2.home)), 'the skill is removed');
  assert(/Rule:\s+Always-on rule: removed/.test(removed.stdout), `the uninstaller says it removed the rule:\n${removed.stdout}`);
  assert(!/databrain-managed/.test(readFileSync(path.join(home2.home, '.codex/config.toml'), 'utf8')), 'no managed block is left');
  assert.equal(readFileSync(path.join(home2.home, '.codex/config.toml'), 'utf8'), otherConfig, 'the settings file is back to its other content, byte for byte');
  assert(!existsSync(path.join(home2.home, 'Library/Application Support/DataBrain/app/0.2.1')), 'this version\'s copy is removed');
  assert.equal(readFileSync(path.join(home2.home, '.agents/skills/someone-elses/SKILL.md'), 'utf8'), 'not ours\n', 'another skill is untouched');
  assert.equal(readFileSync(path.join(home2.home, 'DataBrain/moc/index.tsv'), 'utf8'), 'kept\n', 'the brain is untouched');
  assert(/Your DataBrain \(your index and notes\) and your documents were not touched/.test(removed.stdout), 'it says so');
  const again = uninstall(top, home2.home);
  assert.equal(again.status, 0, 'a second uninstall is harmless');
  assert(/Skill:\s+none to remove/.test(again.stdout), 'and says there was nothing to remove');
  console.log('PASS: the installer adds the save-a-note skill, never overwrites a folder that is not DataBrain\'s, updates only its own; the uninstaller removes the skill, DataBrain\'s settings entry and this version\'s copy and nothing else');
} finally { await fs.rm(work, { recursive: true, force: true }); }
