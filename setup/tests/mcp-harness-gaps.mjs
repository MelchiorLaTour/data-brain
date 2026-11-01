// Shared by the 0.1.38 gap tests (test_gap_*.mjs): unzip the REAL built packages and run them against one fake HOME, old then new.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const downloads = path.join(os.homedir(), 'Downloads');   // read-only use: the packages are only unzipped
export async function stagePackage(version, dest) {
  const file = process.env[`DATABRAIN_PKG_${version.replace(/\./g, '_')}`] || path.join(downloads, `databrain-${version}.mcpb`);
  await fs.mkdir(dest, { recursive: true });
  const out = spawnSync('/usr/bin/unzip', ['-q', file, '-d', dest]);
  if (out.status !== 0) throw new Error(`cannot unzip ${file}: ${out.stderr}`);
  return path.join(dest, 'setup', 'mcp', 'server.mjs');
}
export const sqlite = (db, sql) => spawnSync('/usr/bin/sqlite3', ['-readonly', db, sql], { encoding: 'utf8' }).stdout.trim();
