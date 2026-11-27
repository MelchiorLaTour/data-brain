// databrain_read reads a long note, PDF or Word file to the END in pieces (0.1.30). Before, it stopped after 1,200 characters, so an answer further
// down a long file could never be reached (2026-10-14: "the last poem in my poetry note" was at the bottom of a long note).
//   - every piece says which characters it covers and how long the text is ("Characters 1,200-2,400 of 5,310."), and the pieces join up exactly;
//   - the answer sits after character 4,000 in a note, a PDF and a Word file, and is reached by reading on with `offset`;
//   - the last piece says it is the end; an offset past the end says the text ended; a bad offset is refused.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

delete process.env.DATABRAIN_TEST_NO_AUTO_LABELS;
delete process.env.DATABRAIN_TEST_STEP_BY_STEP;
const here = path.dirname(fileURLToPath(import.meta.url));
const serverScript = process.env.DATABRAIN_SERVER || path.join(here, '../mcp/server.mjs');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-readoffset-')));
const home = path.join(temp, 'home'); const docs = path.join(home, 'Documents');
await fs.mkdir(docs, { recursive: true });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// ~5,400 characters of filler lines, with the answer after character 4,000
const fillerLines = prefix => Array.from({ length: 120 }, (_, i) => `${prefix} line ${i} of ordinary words that say nothing special.`);
const mdLines = fillerLines('note'); mdLines.splice(95, 0, 'The code word is MDANSWERMARK blue heron.');
const mdText = `# Long note\n\n${mdLines.join('\n')}\n`;
assert(mdText.indexOf('MDANSWERMARK') > 4000, 'the markdown answer sits after character 4,000');
await fs.writeFile(path.join(docs, 'long-note.md'), mdText);
const pdfLines = fillerLines('paper'); pdfLines.splice(100, 0, 'The code word is PDFANSWERMARK green frog.');
const docxLines = fillerLines('memo'); docxLines.splice(100, 0, 'The code word is DOCXANSWERMARK red fox.');
const python = String.raw`
import json, sys, zipfile
pdf_lines, docx_lines, pdf_path, docx_path = json.loads(sys.argv[1])
document = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
  + ''.join('<w:p><w:r><w:t>' + line + '</w:t></w:r></w:p>' for line in docx_lines) + '</w:body></w:document>')
with zipfile.ZipFile(docx_path, 'w') as archive: archive.writestr('word/document.xml', document)
pages = [pdf_lines[i:i + 45] for i in range(0, len(pdf_lines), 45)]
objects = [b'<< /Type /Catalog /Pages 2 0 R >>', None]
kids = []
for number, lines in enumerate(pages):
    page_id = 3 + number * 2; content_id = page_id + 1; kids.append(str(page_id) + ' 0 R')
    body = 'BT /F1 10 Tf 13 TL 40 760 Td ' + ' T* '.join('(' + line.replace('(', '\\(').replace(')', '\\)') + ') Tj' for line in lines) + ' ET'
    stream = body.encode()
    objects.append(('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>' % (3 + len(pages) * 2, content_id)).encode())
    objects.append(b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream')
objects[1] = ('<< /Type /Pages /Kids [' + ' '.join(kids) + '] /Count ' + str(len(pages)) + ' >>').encode()
objects.append(b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
data = bytearray(b'%PDF-1.4\n'); offsets = [0]
for number, obj in enumerate(objects, 1):
    offsets.append(len(data)); data.extend(str(number).encode() + b' 0 obj\n' + obj + b'\nendobj\n')
xref = len(data); data.extend(('xref\n0 ' + str(len(offsets)) + '\n0000000000 65535 f \n').encode())
for offset in offsets[1:]: data.extend(('%010d 00000 n \n' % offset).encode())
data.extend(('trailer\n<< /Size ' + str(len(offsets)) + ' /Root 1 0 R >>\nstartxref\n' + str(xref) + '\n%%EOF\n').encode())
open(pdf_path, 'wb').write(data)
`;
const made = spawnSync('python3', ['-c', python, JSON.stringify([pdfLines, docxLines, path.join(docs, 'long-paper.pdf'), path.join(docs, 'long-memo.docx')])], { encoding: 'utf8' });
assert.equal(made.status, 0, `fixture generation failed: ${made.stderr}`);
await fs.writeFile(path.join(docs, 'plain.md'), '# Plain\nreadoffsetmarker an ordinary short note.\n');

let n = 0;
const child = spawn(process.execPath, [serverScript, '--databrain-source-roots', docs], { env: { ...process.env, HOME: home, DATABRAIN_FRESHNESS_CHECK_MS: '3600000' }, stdio: ['pipe', 'pipe', 'pipe'] });
const waiting = new Map();
readline.createInterface({ input: child.stdout }).on('line', line => { const m = JSON.parse(line); waiting.get(m.id)?.(m); });
const ask = (method, params) => new Promise(resolve => { const id = ++n; waiting.set(id, resolve); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); });
const call = async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result;
const tool = async (name, args = {}) => (await call(name, args))?.content?.[0]?.text ?? '';
const until = async (check, label, limit = 150000) => { for (const t0 = Date.now(); !(await check()); await sleep(300)) assert(Date.now() - t0 < limit, `timed out: ${label}`); };

// Reads a file piece by piece; returns every piece's header numbers and the joined text.
async function readAll(file) {
  const pieces = []; let offset = 0; let text = '';
  for (let guard = 0; guard < 60; guard++) {
    const out = await tool('databrain_read', { path: file, offset });
    const head = /^Characters ([\d,]+)-([\d,]+) of ([\d,]+)( \(end of the text\))?\.$/m.exec(out);
    assert(head, `piece at offset ${offset} has a position line:\n${out.slice(0, 400)}`);
    const [from, to, total] = [head[1], head[2], head[3]].map(value => Number(value.replace(/,/g, '')));
    assert.equal(from, offset, `the piece starts where asked (${out.slice(0, 200)})`);
    text += out.slice(out.indexOf(head[0]) + head[0].length + 1);
    pieces.push({ from, to, total, end: Boolean(head[4]) });
    if (head[4]) return { pieces, text };
    offset = to;
  }
  assert.fail('the text never ended');
}

try {
  await ask('initialize', { protocolVersion: '2025-03-26' }); child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await tool('databrain_setup_start');
  await until(async () => /Stage: ready\./.test(await tool('databrain_setup_status')), 'setup reaches ready');
  const where = {};
  for (const [name, word] of [['long-note.md', 'MDANSWERMARK'], ['long-paper.pdf', 'PDFANSWERMARK'], ['long-memo.docx', 'DOCXANSWERMARK']]) {
    await until(async () => { const found = await tool('databrain_search', { query: word }); where[name] = new RegExp(`^\\s*\\d+\\s+-?[0-9.]+\\s+(.+${name.replace('.', '\\.')})\\s*$`, 'm').exec(found)?.[1]; return where[name]; }, `${name} is found by its answer word`);
  }

  // the note: the first piece does not hold the answer; reading on reaches it; the pieces join into the whole text
  // offset 0 on purpose: without an offset a read that follows a search opens at the matched place (0.1.31 item 11, test_mcp_read_opens_at_match.mjs)
  const first = await tool('databrain_read', { path: where['long-note.md'], offset: 0 });
  assert(/^Characters 0-1,200 of [\d,]+\.$/m.test(first), `the first piece says what it covers:\n${first.slice(0, 300)}`);
  assert(!/MDANSWERMARK/.test(first), 'the answer is not in the first 1,200 characters');
  const note = await readAll(where['long-note.md']);
  assert(note.pieces.length >= 4, `the note takes several pieces (${note.pieces.length})`);
  for (let i = 1; i < note.pieces.length; i++) assert.equal(note.pieces[i].from, note.pieces[i - 1].to, 'pieces join up with no gap and no overlap');
  assert.equal(note.pieces.at(-1).to, note.pieces[0].total, 'the last piece ends at the total');
  assert.equal(note.pieces[0].total, mdText.length, 'the total is the length of the note');
  assert.equal(note.text, mdText, 'the pieces joined are exactly the note');
  const answerPiece = note.pieces.find(piece => piece.from <= mdText.indexOf('MDANSWERMARK') && mdText.indexOf('MDANSWERMARK') < piece.to);
  assert(answerPiece.from >= 3600, `the answer is reached in a piece that starts after character 3,600 (${answerPiece.from})`);
  const middle = await tool('databrain_read', { path: where['long-note.md'], offset: answerPiece.from });
  assert(/MDANSWERMARK blue heron/.test(middle), 'reading at the answer\'s offset returns the answer');

  // the PDF and the Word file: the answer sits after character 4,000 of their text and is reached the same way
  for (const [name, word, color] of [['long-paper.pdf', 'PDFANSWERMARK', 'green frog'], ['long-memo.docx', 'DOCXANSWERMARK', 'red fox']]) {
    const whole = await readAll(where[name]);
    const at = whole.text.indexOf(word);
    assert(at > 4000, `${name}: the answer is after character 4,000 of its text (at ${at})`);
    assert(whole.text.includes(`${word} ${color}`), `${name}: the whole text was read to its end`);
    assert(!(await tool('databrain_read', { path: where[name], offset: 0 })).includes(word), `${name}: the first piece does not hold it`);
    assert(whole.pieces.every(piece => piece.total === whole.pieces[0].total), `${name}: the total is the same in every piece`);
  }

  // past the end, and a bad offset
  const past = await tool('databrain_read', { path: where['long-note.md'], offset: mdText.length + 500 });
  assert(/The text ends at character [\d,]+/.test(past), `an offset past the end says the text ended:\n${past.slice(0, 300)}`);
  const bad = await tool('databrain_read', { path: where['long-note.md'], offset: -5 });
  assert(/offset must be a whole number/.test(bad), `a negative offset is refused:\n${bad.slice(0, 200)}`);
  const spec = (await ask('tools/list', {})).result.tools.find(tool => tool.name === 'databrain_read');
  assert(spec.inputSchema.properties.offset, 'the tool has an offset');
  assert(/offset/.test(spec.description) && /further down/.test(spec.description), 'the description tells Claude to keep reading when the answer may be further down');
  console.log('PASS: databrain_read reads a long note, PDF and Word file to the end in pieces; each piece says which characters it covers and the total; the pieces join exactly; an answer after character 4,000 is reached with offset; the end, an offset past the end and a bad offset are handled.');
} finally {
  child.kill('SIGKILL'); await sleep(1000);
  await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
}
