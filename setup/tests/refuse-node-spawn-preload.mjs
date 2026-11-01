// Test-only preload (node --import): behaves like Claude's "Use built-in Node.js for MCP" runtime. Any child process that would start
// node or the app executable (process.execPath, or a bare "node") is refused, and the attempt is appended to $DATABRAIN_TEST_REFUSE_LOG.
// Other programs (bash, perl, sqlite3, ...) start normally.
import cp from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const log = process.env.DATABRAIN_TEST_REFUSE_LOG;
const refused = '/nonexistent/built-in-node-refused';
const blocked = file => typeof file === 'string' && (file === process.execPath || path.basename(file) === 'node');
function note(api, file) { if (log) appendFileSync(log, `${api} ${file}\n`); }
const error = file => Object.assign(new Error(`The built-in Node.js runtime cannot start "${path.basename(file)}" as a Node.js subprocess (child_process.fork or process.execPath).`), { code: 'ERR_MCP_NODE_HOST_NOT_NODE' });

const { spawn, spawnSync, execFileSync, execSync, execFile, exec, fork } = cp;
cp.spawn = function (file, ...rest) { if (!blocked(file)) return spawn.call(this, file, ...rest); note('spawn', file); return spawn.call(this, refused, ...rest); };
cp.spawnSync = function (file, ...rest) { if (!blocked(file)) return spawnSync.call(this, file, ...rest); note('spawnSync', file); return { pid: 0, output: [null, '', ''], stdout: '', stderr: '', status: null, signal: null, error: error(file) }; };
cp.execFileSync = function (file, ...rest) { if (!blocked(file)) return execFileSync.call(this, file, ...rest); note('execFileSync', file); throw error(file); };
cp.execSync = function (command, ...rest) { const first = String(command).trim().split(/\s+/)[0]; if (!blocked(first)) return execSync.call(this, command, ...rest); note('execSync', first); throw error(first); };
cp.execFile = function (file, ...rest) { if (!blocked(file)) return execFile.call(this, file, ...rest); note('execFile', file); return execFile.call(this, refused, ...rest); };
cp.exec = function (command, ...rest) { const first = String(command).trim().split(/\s+/)[0]; if (!blocked(first)) return exec.call(this, command, ...rest); note('exec', first); return exec.call(this, refused, ...rest); };
cp.fork = function (module, ...rest) { note('fork', module); throw error(process.execPath); };
syncBuiltinESMExports();
