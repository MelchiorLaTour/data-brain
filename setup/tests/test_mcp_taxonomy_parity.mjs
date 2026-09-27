import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const engine = path.resolve(process.argv[2] || path.resolve(here, '../..'));
const { applyConfirmedTaxonomy, proposeTaxonomyCandidates } = await import(pathToFileURL(path.join(engine, 'setup/mcp/taxonomy-core.mjs')));
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-taxonomy-')));
try {
  const source = path.join(temp, 'approved source');
  const outside = path.join(temp, 'outside');
  const moc = path.join(temp, 'moc');
  await Promise.all([fs.mkdir(path.join(source, 'Projects', 'Nested'), { recursive: true }), fs.mkdir(outside), fs.mkdir(moc)]);
  const originals = [
    path.join(source, 'Projects', 'one.md'),
    path.join(source, 'Projects', 'Nested', 'two.md'),
    path.join(source, 'Projects', 'labeled.md'),
    path.join(source, 'Other', 'three.md'),
    path.join(outside, 'escape.md'),
  ];
  for (const file of originals) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `BODY_ONLY_SECRET original:${file}\n`);
  }
  const beforeOriginals = await Promise.all(originals.map(async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  const index = [
    '# path\ttitle\tcategory\tkeywords',
    `${originals[0]}\tOne\t-\talpha`,
    `${originals[1]}\tTwo\t\tbeta`,
    `${originals[2]}\tLabeled\tkept\tgamma`,
    `${originals[3]}\tOther\t-\tdelta`,
    `${originals[4]}\tOutside\t-\tepsilon`,
    '',
  ].join('\n');
  const roots = [source];
  const indexPath = path.join(moc, 'index.tsv');
  const rootsPath = path.join(temp, 'roots.txt');
  await fs.writeFile(indexPath, index, { mode: 0o600 });
  await fs.writeFile(rootsPath, `${source}\n`, { mode: 0o600 });
  const proposal = proposeTaxonomyCandidates(index, roots);
  assert.equal(proposal.rows.length, 2, 'only selected-root folders should be proposed');
  assert.deepEqual(proposal.rows[0], {
    id: `folder-${createHash('sha1').update(path.join(source, 'Other')).digest('hex').slice(0, 12)}`,
    folderPath: path.join(source, 'Other'), folder: 'approved source / Other', files: 1,
    existingLabels: [], titles: ['Other'], keywords: ['delta (1)'],
  }, 'candidate IDs, names, counts, labels, titles, and keyword ordering stay deterministic');
  const terminalProposal = spawnSync('bash', [path.join(engine, 'bin/taxonomy.sh'), 'propose'], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: rootsPath },
  });
  assert.equal(terminalProposal.status, 0, `Terminal candidate proposal failed: ${terminalProposal.stderr}`);
  assert.equal(terminalProposal.stdout.trimEnd(), proposal.text, 'Terminal and app candidate records must match exactly');
  assert(!terminalProposal.stdout.includes('BODY_ONLY_SECRET'), 'candidate proposal must not expose document bodies');
  assert.equal(await fs.readFile(indexPath, 'utf8'), index, 'proposing categories must not alter the index');

  const assignments = [
    { folder: path.join(source, 'Projects'), categories: ['project', 'work'] },
    { folder: path.join(source, 'Projects', 'Nested'), categories: ['deep'] },
  ];
  const appResult = applyConfirmedTaxonomy(index, roots, assignments);
  assert.equal(appResult.changed, 2, 'only unlabeled rows under confirmed folders should change');
  assert.match(appResult.output, new RegExp(`${originals[0]}\\tOne\\tproject,work`));
  assert.match(appResult.output, new RegExp(`${originals[1]}\\tTwo\\tdeep`), 'more-specific confirmed folder wins');
  assert.match(appResult.output, new RegExp(`${originals[2]}\\tLabeled\\tkept`), 'existing category is preserved');
  assert.match(appResult.output, new RegExp(`${originals[3]}\\tOther\\t-`), 'unassigned folder remains unlabeled');
  assert.match(appResult.output, new RegExp(`${originals[4]}\\tOutside\\t-`), 'row outside grant remains untouched');

  const terminal = spawnSync('bash', [path.join(engine, 'bin/taxonomy.sh'), 'apply', ...assignments.map(item => `${item.folder}=${item.categories.join(',')}`)], {
    encoding: 'utf8',
    env: { ...process.env, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: rootsPath },
  });
  assert.equal(terminal.status, 0, `Terminal taxonomy application failed: ${terminal.stderr}`);
  assert.equal(await fs.readFile(indexPath, 'utf8'), appResult.output, 'Terminal and app must produce exact identical index semantics');
  assert.match(terminal.stdout, /Applied confirmed categories to 2 previously unlabeled row/);
  const committedIndex = await fs.readFile(indexPath, 'utf8');
  for (const invalid of [`${path.join(temp, 'unapproved')}=valid`, `${path.join(source, 'Projects')}=Not-valid`]) {
    const rejected = spawnSync('bash', [path.join(engine, 'bin/taxonomy.sh'), 'apply', invalid], {
      encoding: 'utf8',
      env: { ...process.env, NB_MOC_DIR: moc, NB_CANON_ROOTS_FILE: rootsPath },
    });
    assert.notEqual(rejected.status, 0, `Terminal should reject invalid assignment ${invalid}`);
    assert.equal(await fs.readFile(indexPath, 'utf8'), committedIndex, 'rejected assignments must leave the index unchanged');
  }
  const afterOriginals = await Promise.all(originals.map(async file => createHash('sha256').update(await fs.readFile(file)).digest('hex')));
  assert.deepEqual(afterOriginals, beforeOriginals, 'taxonomy must never modify source originals');

  assert.throws(() => applyConfirmedTaxonomy(index, roots, [{ folder: path.join(temp, 'unapproved'), categories: ['valid'] }]), /outside the selected source folders/);
  assert.throws(() => applyConfirmedTaxonomy(index, roots, [{ folder: path.join(source, 'Projects'), categories: ['Not valid'] }]), /lowercase names/);
  assert.throws(() => applyConfirmedTaxonomy(index, roots, [{ folder: path.join(source, 'Projects'), categories: [] }]), /1–5 categories/);
  process.stdout.write('PASS: app and Terminal taxonomy proposals match and expose metadata only; confirmed application preserves labels, ungranted rows, and originals.\n');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
