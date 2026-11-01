// 0.1.41: files with capital-letter extensions (.PDF .TXT .DOCX .MD, from scanners and phones) are indexed like their lowercase twins.
// Privacy first: Secret.PDF (a password inside) and passport.PDF (held by name) are held exactly like lowercase twins. After setup and a refresh
// freshness is current and Selected-source health passes. (Twins have other base names: the macOS disk ignores case, Report.PDF = report.pdf.)
// Mutant (E41_MUTANT=name): bin/ingest-root.sh matches by -name again -> the capital-letter files are never indexed -> must FAIL.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

let serverPath = process.env.DATABRAIN_SERVER;
let mutantDir = null;
if (process.env.E41_MUTANT) {
  mutantDir = await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-e41-mutant-'));
  await fs.cp(path.dirname(path.dirname(path.dirname(serverPath))), path.join(mutantDir, 'pkg'), { recursive: true });
  serverPath = path.join(mutantDir, 'pkg', 'setup', 'mcp', 'server.mjs');
  const script = path.join(mutantDir, 'pkg', 'bin', 'ingest-root.sh');
  const before = await fs.readFile(script, 'utf8');
  const after = before.replaceAll('-iname', '-name');
  assert.notEqual(after, before, 'mutation applied'); await fs.writeFile(script, after);
}
process.env.DATABRAIN_SERVER = serverPath;
const { fakeHome, initialize, setupToReady, startServer, sleep, until } = await import('./mcp-harness-0138.mjs');
const { temp, home, docs, dataHome } = await fakeHome('capext');

const python = String.raw`
import json, sys, zipfile
specs = json.loads(sys.argv[1])
def pdf(path, text):
    lines = [text, 'ordinary words that say nothing special.']
    body = 'BT /F1 12 Tf 14 TL 40 760 Td ' + ' T* '.join('(' + l.replace('(', '\\(').replace(')', '\\)') + ') Tj' for l in lines) + ' ET'
    stream = body.encode()
    objects = [b'<< /Type /Catalog /Pages 2 0 R >>', b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
      b'<< /Length ' + str(len(stream)).encode() + b' >>\nstream\n' + stream + b'\nendstream', b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
    data = bytearray(b'%PDF-1.4\n'); offsets = []
    for n, obj in enumerate(objects, 1):
        offsets.append(len(data)); data.extend(str(n).encode() + b' 0 obj\n' + obj + b'\nendobj\n')
    xref = len(data); data.extend(('xref\n0 ' + str(len(offsets) + 1) + '\n0000000000 65535 f \n').encode())
    for o in offsets: data.extend(('%010d 00000 n \n' % o).encode())
    data.extend(('trailer\n<< /Size ' + str(len(offsets) + 1) + ' /Root 1 0 R >>\nstartxref\n' + str(xref) + '\n%%EOF\n').encode())
    open(path, 'wb').write(data)
def docx(path, text):
    doc = ('<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>')
    with zipfile.ZipFile(path, 'w') as z: z.writestr('word/document.xml', doc)
for path, text in specs:
    if path.lower().endswith('.pdf'): pdf(path, text)
    elif path.lower().endswith('.docx'): docx(path, text)
    else: open(path, 'w').write(text + '\n')
`;
const wanted = {   // file -> content marker (all invented)
  'Report.PDF': 'capmarkerreportpdf', 'notes.TXT': 'capmarkernotestxt', 'Letter.DOCX': 'capmarkerletterdocx', 'Idea.MD': 'capmarkerideamd',
  'report-low.pdf': 'lowmarkerreportpdf', 'notes-low.txt': 'lowmarkernotestxt', 'letter-low.docx': 'lowmarkerletterdocx', 'idea-low.md': 'lowmarkerideamd',
};
const held = {      // file -> text; both capital and lowercase twins must be held
  'Secret.PDF': 'heldcapsecret the wifi password: hunter2secret for the router',
  'secret-low.pdf': 'heldlowsecret the wifi password: hunter2secret for the router',
  'passport.PDF': 'heldcappassport ordinary words only',
  'passport-low.pdf': 'heldlowpassport ordinary words only',
};
const specs = Object.entries({ ...wanted, ...held }).map(([name, text]) => [path.join(docs, name), name.endsWith('.MD') || name.endsWith('.md') ? `# ${name}\n${text}\n` : text]);
specs[Object.keys(wanted).indexOf('Idea.MD')][1] = '# Idea\ncapmarkerideamd tags stay with the real case\n';
const made = spawnSync('python3', ['-I', '-c', python, JSON.stringify(specs)], { encoding: 'utf8' });
assert.equal(made.status, 0, `fixture generation failed: ${made.stderr}`);
// "passport" in the NAME of the second held pair: rename so the name screen (not the content) holds them
await fs.rename(path.join(docs, 'passport.PDF'), path.join(docs, 'passport scan.PDF'));
await fs.rename(path.join(docs, 'passport-low.pdf'), path.join(docs, 'passport scan low.pdf'));

const server = startServer({ home, roots: [docs], env: { DATABRAIN_FRESHNESS_CHECK_MS: '100' } });
const index = () => fs.readFile(path.join(dataHome, 'moc', 'index.tsv'), 'utf8');
const idle = () => until(async () => { const t = await server.tool('databrain_setup_status'); return /Stage: (ready|verification pending)\./.test(t) && !/: running — /.test(t); }, 'jobs idle', 240000);
let last = '';
try {
  await initialize(server);
  await setupToReady(server);
  await idle();
  let rows = await index();
  for (const name of Object.keys(wanted)) assert(rows.includes(`/${name}\t`), `${name} is indexed:\n${rows}`);
  assert(rows.includes('/Idea.MD\tIdea\t'), 'the title of Idea.MD is "Idea" (the real-case suffix is stripped)');
  for (const [name, marker] of Object.entries(wanted)) {
    const found = await server.tool('databrain_search', { query: marker });
    assert(found.includes(name), `${name} is searchable by its content (${marker}):\n${found.slice(0, 300)}`);
  }
  // privacy: capital twins held exactly like the lowercase ones
  for (const name of ['Secret.PDF', 'secret-low.pdf', 'passport scan.PDF', 'passport scan low.pdf']) assert(!rows.includes(`/${name}\t`), `${name} is held, not indexed`);
  for (const marker of ['heldcapsecret', 'heldlowsecret', 'heldcappassport', 'heldlowpassport', 'hunter2secret']) {
    const found = await server.tool('databrain_search', { query: marker });
    assert(!/Secret\.PDF|secret-low|passport scan/i.test(found), `${marker} is not searchable`);
  }
  // refresh, then freshness is current and health passes
  await fs.writeFile(path.join(docs, 'idea-low.md'), '# idea-low.md\nlowmarkerideamd edited once\n');
  await server.tool('databrain_refresh'); await idle();
  last = await server.tool('databrain_verify_install');
  const line = last.split('\n').find(l => l.includes('Selected-source health'));
  console.log(line);
  assert(/^PASS: Selected-source health/.test(line) && /freshness current/.test(line), `health passes after a refresh: ${line}`);
  const health = await server.tool('databrain_health');
  assert(/Source freshness: current/.test(health) && !/reported an issue/.test(health), `health reports no gap:\n${health}`);
  console.log('PASS capital extensions');
} catch (error) { console.error('LAST VERIFY:\n' + last); throw error; }
finally { server.child.kill('SIGTERM'); await sleep(500); await fs.rm(temp, { recursive: true, force: true }).catch(() => {}); if (mutantDir) await fs.rm(mutantDir, { recursive: true, force: true }).catch(() => {}); }
