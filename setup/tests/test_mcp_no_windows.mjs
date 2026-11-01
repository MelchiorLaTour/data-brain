// DataBrain opens no window and shows no notification banner: the package holds no folder-picker script, and no packaged file starts a
// macOS dialog, folder chooser, alert or notification. Everything the user is asked happens in the chat.
// Usage: node test_mcp_no_windows.mjs [engine-root]
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const mcp = path.join(engine, 'setup/mcp');
const files = (await fs.readdir(mcp)).filter(name => /\.(mjs|js)$/.test(name));
assert(!files.includes('folder-picker.js'), 'the folder-picker script must not ship');
const forbidden = [/NSAlert/, /NSOpenPanel/, /NSApplication/, /display notification/, /display dialog/, /choose folder (?:with|of type)/, /folder-picker/, /notifyUser/];
for (const name of files) {
  const text = await fs.readFile(path.join(mcp, name), 'utf8');
  for (const pattern of forbidden) assert(!pattern.test(text), `${name} must not contain ${pattern}`);
}
// Mutant: a window call in any packaged file is caught.
assert(forbidden.some(pattern => pattern.test('$.NSAlert.alloc.init')), 'the check sees an NSAlert call');
console.log('PASS: no packaged file opens a window, a chooser or a notification (folder-picker.js is gone).');
