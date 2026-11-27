// 0.2.1 startup budget: ChatGPT gives a local server 10 seconds to start. This builds an invented brain of FILES notes in a fake HOME
// (kept between runs), then measures, on each Node binary, how long a fresh server process takes to answer `initialize` and `tools/list`
// against that brain, plus the first setup_status call. Not a pass/fail gate for the suite: it prints the measured numbers.
//   node measure_startup_021.mjs <brain-dir> [files=3000] [node ...]
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setupFromChat, startChatgpt } from './chatgpt-harness.mjs';

const [, , brainDir, filesArg = '3000', ...nodes] = process.argv;
const FILES = Number(filesArg);
const home = path.join(brainDir, 'home');
const notes = path.join(home, 'Notes');
const exists = p => fs.stat(p).then(() => true, () => false);
const words = ['garden', 'trellis', 'bakery', 'invoice', 'ember', 'harbor', 'violin', 'meadow', 'lantern', 'orchard', 'granite', 'compass'];

if (!(await exists(path.join(home, 'DataBrain', '.databrain', 'desktop-state.json')))) {
  await fs.mkdir(notes, { recursive: true });
  for (let i = 0; i < FILES; i += 1) {
    const sub = path.join(notes, `topic-${i % 40}`);
    await fs.mkdir(sub, { recursive: true });
    const body = Array.from({ length: 12 }, (_, line) => `${words[(i + line) % words.length]} ${words[(i * 7 + line) % words.length]} entry${i}x${line} number ${i * 31 + line}`).join('\n');
    await fs.writeFile(path.join(sub, `note-${i}.md`), `# Note ${i}\nuniquebrainword${i}\n${body}\n`);
  }
  const server = startChatgpt({ home, node: nodes[0] || process.execPath });
  await server.initialize();
  const t0 = performance.now();
  await setupFromChat(server, [notes], { limit: 3000000 });
  console.log(`built an invented brain of ${FILES} files in ${((performance.now() - t0) / 1000).toFixed(1)} s (setup to "ready")`);
  await server.stop();
}

const count = (await fs.readFile(path.join(home, 'DataBrain', 'moc', 'index.tsv'), 'utf8')).split('\n').filter(Boolean).length;
console.log(`brain on disk: ${count} index rows; ${FILES} note files written`);
for (const node of nodes.length ? nodes : [process.execPath]) {
  const version = (await import('node:child_process')).spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim();
  const rows = [];
  for (let run = 0; run < 5; run += 1) {
    const t0 = performance.now();
    const server = startChatgpt({ home, node });
    const init = await server.ask('initialize', { protocolVersion: '2025-03-26' });
    const tInit = performance.now() - t0;
    server.child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    const t1 = performance.now();
    const list = await server.ask('tools/list', {});
    const tList = performance.now() - t1;
    const t2 = performance.now();
    await server.tool('databrain_setup_status');
    const tStatus = performance.now() - t2;
    if (!init.result || !list.result?.tools?.length) throw new Error('server did not answer');
    rows.push({ init: tInit, list: tList, status: tStatus, total: performance.now() - t0 });
    await server.stop();
  }
  const fmt = key => `${rows.map(row => (row[key] / 1000).toFixed(2)).join(', ')} s`;
  console.log(`${version} (${node}): initialize ${fmt('init')} | tools/list ${fmt('list')} | first setup_status ${fmt('status')} | process start to tools/list ${fmt('total')}`);
}
