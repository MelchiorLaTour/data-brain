// Boot test for a packaged DataBrain for ChatGPT: start the server with the package's own Node, ask it to initialize, list its tools and
// report setup status. Run with HOME set to an empty folder; usage: node boot-check.mjs <package payload folder>
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const payload = path.resolve(process.argv[2] || '');
const child = spawn(process.execPath, [path.join(payload, 'setup/mcp/server.mjs'), '--databrain-client', 'chatgpt'], { stdio: ['pipe', 'pipe', 'inherit'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { try { const m = JSON.parse(line); waiting.get(m.id)?.(m); } catch {} });
let n = 0;
const ask = (method, params) => new Promise((resolve, reject) => {
  const id = ++n;
  const timer = setTimeout(() => reject(new Error(`${method} did not answer within 10 seconds`)), 10000);
  waiting.set(id, reply => { clearTimeout(timer); resolve(reply); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
try {
  const started = Date.now();
  const init = await ask('initialize', { protocolVersion: '2025-03-26', capabilities: { elicitation: { form: {} } } });
  const tools = await ask('tools/list', {});
  const status = await ask('tools/call', { name: 'databrain_setup_status', arguments: {} });
  const text = status.result?.content?.[0]?.text ?? '';
  if (init.result?.serverInfo?.name !== 'databrain') throw new Error('initialize did not name databrain');
  if (!/^\d+\.\d+\.\d+$/.test(init.result.serverInfo.version)) throw new Error(`unexpected version ${init.result.serverInfo.version}`);
  if (!Array.isArray(tools.result?.tools) || tools.result.tools.length < 20) throw new Error('tools/list returned too few tools');
  if (!text) throw new Error('setup_status returned nothing');
  console.log(`Boot test OK: node ${process.version}, DataBrain ${init.result.serverInfo.version}, ${tools.result.tools.length} tools, setup_status answered (${Date.now() - started} ms for all three). Status begins: ${text.split('\n')[0]}`);
} catch (error) {
  console.error(`Boot test FAILED: ${error.message}`);
  process.exitCode = 1;
} finally {
  child.kill();
}
