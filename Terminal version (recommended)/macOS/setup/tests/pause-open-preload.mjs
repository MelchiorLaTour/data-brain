import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';

const target = process.env.DATABRAIN_TEST_OPEN_PATH;
const arm = process.env.DATABRAIN_TEST_OPEN_ARM;
const signal = process.env.DATABRAIN_TEST_OPEN_SIGNAL;
const release = process.env.DATABRAIN_TEST_OPEN_RELEASE;
const originalOpen = fs.open.bind(fs);
let lastArmToken = '';
const noteTarget = process.env.DATABRAIN_TEST_NOTE_OPEN_PATH;
const noteArm = process.env.DATABRAIN_TEST_NOTE_OPEN_ARM;
const noteSignal = process.env.DATABRAIN_TEST_NOTE_OPEN_SIGNAL;
const noteRelease = process.env.DATABRAIN_TEST_NOTE_OPEN_RELEASE;
let lastNoteArmToken = '';
const originalOpenSync = fsSync.openSync.bind(fsSync);

function exists(file) {
  try { lstatSync(file); return true; } catch { return false; }
}

fs.open = async (file, ...args) => {
  const armToken = arm && exists(arm) ? readFileSync(arm, 'utf8') : '';
  if (armToken && armToken !== lastArmToken && target && signal && release && typeof file === 'string' &&
      path.resolve(file) === path.resolve(target)) {
    lastArmToken = armToken;
    writeFileSync(signal, 'paused');
    const deadline = Date.now() + 5000;
    while (!exists(release) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  }
  return originalOpen(file, ...args);
};

fsSync.openSync = (file, ...args) => {
  const armToken = noteArm && exists(noteArm) ? readFileSync(noteArm, 'utf8') : '';
  if (armToken && armToken !== lastNoteArmToken && noteTarget && noteSignal && noteRelease &&
      typeof file === 'string' && path.resolve(file) === path.resolve(noteTarget)) {
    lastNoteArmToken = armToken;
    writeFileSync(noteSignal, 'paused');
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (!exists(noteRelease) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);
  }
  return originalOpenSync(file, ...args);
};

const realpathTarget = process.env.DATABRAIN_TEST_REALPATH_PATH;
const realpathArm = process.env.DATABRAIN_TEST_REALPATH_ARM;
const realpathSignal = process.env.DATABRAIN_TEST_REALPATH_SIGNAL;
const realpathRelease = process.env.DATABRAIN_TEST_REALPATH_RELEASE;
const originalRealpathSync = fsSync.realpathSync.bind(fsSync);
let lastRealpathArmToken = '';
fsSync.realpathSync = (file, ...args) => {
  const armToken = realpathArm && exists(realpathArm) ? readFileSync(realpathArm, 'utf8') : '';
  if (armToken && armToken !== lastRealpathArmToken && realpathTarget && realpathSignal && realpathRelease &&
      typeof file === 'string' && path.resolve(file) === path.resolve(realpathTarget)) {
    lastRealpathArmToken = armToken;
    writeFileSync(realpathSignal, 'paused');
    const waitCell = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + 5000;
    while (!exists(realpathRelease) && Date.now() < deadline) Atomics.wait(waitCell, 0, 0, 10);
  }
  return originalRealpathSync(file, ...args);
};
syncBuiltinESMExports();
