// Disposable synthetic engineering exam through the index/extract/keyword/search
// pipeline. Questions are fixed before scoring and avoid synthetic answer tokens.
// This is not personal or held-out corpus evidence and does not judge Claude's final
// answer or citations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const [engine] = process.argv.slice(2);
assert(engine, 'usage: test_mcp_recall_exam.mjs ENGINE');
const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'databrain-recall-exam-')));
const corpus = path.join(temp, 'selected-notes');
const moc = path.join(temp, 'moc');
const rootsFile = path.join(temp, 'roots.txt');
await fs.mkdir(corpus);
await fs.mkdir(moc);
await fs.writeFile(rootsFile, `${await fs.realpath(corpus)}\n`);
const env = { ...process.env, NB_CANON_ROOTS_FILE: rootsFile, NB_MOC_DIR: moc, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };
const rows = [];
let server;
const rowSequence = new Map();
const variantFixture = new Map();
const fixturePath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'recall-query-variants.tsv');
for (const [lineNumber, line] of (await fs.readFile(fixturePath, 'utf8')).trimEnd().split('\n').entries()) {
  if (lineNumber === 0) {
    assert.equal(line, 'id\tstratum\tquestion\tvariant1\tvariant2', 'query-variant fixture schema changed');
    continue;
  }
  const [id, stratum, question, variant1, variant2] = line.split('\t');
  assert(id && stratum && question && variant1, `invalid query-variant row ${lineNumber + 1}`);
  assert(!variantFixture.has(id), `duplicate query-variant ID ${id}`);
  variantFixture.set(id, { stratum, question, variants: [variant1, variant2].filter(Boolean) });
}
const originalDigests = new Map();
const slug = value => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
async function note(name, content) {
  const filename = `${slug(name)}.md`;
  const file = path.join(corpus, filename);
  const original = `# ${name}\n\n${content}\n`;
  await fs.writeFile(file, original);
  originalDigests.set(filename, createHash('sha256').update(original).digest('hex'));
  return filename;
}
function add(stratum, question, expected, { trap = false, plausible = false, variants = [] } = {}) {
  const count = (rowSequence.get(stratum) ?? 0) + 1;
  rowSequence.set(stratum, count);
  const prefix = stratum.toUpperCase();
  const id = `${prefix}-${String(count).padStart(2, '0')}`;
  rows.push({ id, stratum, question, expected, trap, plausible, variants });
}

// Easy: direct wording, no generated identifiers in either query or answer.
const easy = [
  ['refund window', 'How long does a customer have to request a refund?', 'Customers may request a refund within 30 days of purchase.'],
  ['invoice due date', 'When is an invoice due after it is issued?', 'Invoices are due 14 days after the issue date.'],
  ['meeting recording', 'Where is the recording saved after a meeting?', 'Meeting recordings are saved in the shared team drive.'],
  ['office closure', 'Which weekday is the office closed?', 'The office is closed on Sundays.'],
  ['expense receipt', 'What must staff attach to an expense claim?', 'Attach the itemized receipt to every expense claim.'],
  ['account recovery', 'Who can reset a locked account?', 'The service desk can reset a locked account after identity checks.'],
  ['contract archive', 'Where are signed contracts stored?', 'Store signed contracts in the legal archive.'],
  ['project handoff', 'What document is required at project handoff?', 'The project handoff requires a completed transition checklist.'],
  ['travel approval', 'Who approves international travel?', 'A department director must approve international travel.'],
  ['data retention', 'How long are support recordings kept?', 'Support call recordings are retained for 90 days.'],
];
for (const [title, question, answer] of easy) {
  const target = await note(`Easy ${title}`, answer);
  add('Easy', question, [target]);
}

// Medium: paraphrases use ordinary vocabulary and multiple answer-bearing files;
// no row contains a synthetic anchor that uniquely identifies its expected notes.
const medium = [
  ['refund exception', 'Who may grant an exception to the return policy?', 'A regional manager may approve a refund outside the normal return policy.', 'Refund exceptions require sign-off from the regional manager.', 'The customer team explains the standard refund window and return process.'],
  ['account recovery', 'What second check is required when regaining account access?', 'Account recovery requires a second factor after the password is reset.', 'Users restoring access must complete multi-factor verification.', 'The help desk can unlock a profile after confirming the employee number.'],
  ['invoice terms', 'When should the supplier expect payment?', 'Supplier invoices are settled within thirty days of receipt.', 'Payment terms require the company to pay each vendor invoice within 30 days.', 'The finance team reviews invoices before they enter the payment queue.'],
  ['records deletion', 'What happens when the storage period ends?', 'Records are deleted when their approved retention period expires.', 'Expired records must be removed after the retention deadline.', 'Archived records remain available to legal staff during an active case.'],
  ['incident escalation', 'Where should a serious service interruption be reported?', 'Major service incidents go to the incident commander for escalation.', 'Report a critical outage through the incident escalation channel.', 'Routine service requests belong in the customer support queue.'],
  ['trip authorization', 'Which person signs off on an employee trip?', 'The department head authorizes employee travel before booking.', 'Staff need manager approval before reserving a business trip.', 'Travel coordinators arrange tickets after approval has been recorded.'],
  ['license renewal', 'How early should a software subscription be renewed?', 'Renew software licenses at least 30 days before their expiration.', 'Subscription renewals should begin a month before the license ends.', 'The procurement team compares software prices during quarterly review.'],
  ['delivery status', 'How can a buyer check whether an order has arrived?', 'Customers can use the carrier tracking page to check delivery status.', 'The shipping reference shows whether a parcel has reached its destination.', 'The warehouse team records damaged items before dispatch.'],
  ['decision owner', 'Who is responsible for completing an action agreed in a meeting?', 'The person named as action owner is responsible for the agreed follow-up.', 'Meeting decisions must assign each follow-up task to a named owner.', 'The facilitator publishes the minutes after the discussion ends.'],
  ['candidate interview', 'What is the next step after a promising application?', 'A promising applicant is invited to a structured interview.', 'Recruiters schedule an interview when the application meets the role criteria.', 'The hiring panel writes its feedback after each candidate meeting.'],
];
for (const [topic, question, answerA, answerB, distractor] of medium) {
  const a = await note(`Medium ${topic} primary`, answerA);
  const b = await note(`Medium ${topic} supporting`, answerB);
  await note(`Medium ${topic} nearby`, distractor);
  add('Medium', question, [a, b]);
}

// Hard: indirect questions with two competing notes per case. The query omits
// case IDs and unique answer values; decoys deliberately share the topic language.
const hard = [
  ['after-hours outage', 'Who takes the first call when a system fails overnight?', 'For overnight system outages, contact the on-call engineer first.', 'The service desk logs system questions during normal office hours.', 'The change coordinator schedules planned system downtime after hours.'],
  ['card dispute', 'Which group investigates a payment the customer says they did not make?', 'The billing team investigates disputed card charges and unauthorized payments.', 'The finance team reconciles card payment totals at month end.', 'Customer care explains how to update a saved payment card.'],
  ['broken shipment', 'Who handles goods damaged before they reach the buyer?', 'The claims team reviews damaged shipments and contacts the carrier.', 'Warehouse staff inspect packages before loading each shipment.', 'Customer support tracks orders that have not yet arrived.'],
  ['policy exception', 'Who can authorize a departure from the usual rule?', 'A policy exception requires written approval from the compliance director.', 'The policy owner publishes rule changes after legal review.', 'The operations team records routine compliance checks.'],
  ['data exposure', 'What is the first internal step after private information is exposed?', 'Report a data exposure immediately to the privacy response lead.', 'The security team reviews routine access to private information.', 'The privacy office updates notices after a policy revision.'],
  ['supplier screening', 'When is a new vendor checked for risk?', 'Complete supplier risk screening before signing a new vendor contract.', 'Vendor invoices are reviewed before payment is released.', 'The contract owner checks renewal dates for existing suppliers.'],
  ['backup restore', 'Who coordinates bringing a lost service back from a copy?', 'The recovery lead coordinates restoring service from the latest backup.', 'The storage team monitors backup copies for completion.', 'The incident lead sends customer updates during service recovery.'],
  ['safety concern', 'Where does an employee report an unsafe condition?', 'Employees report workplace safety hazards to the site safety officer.', 'Facilities staff handle routine repairs to office equipment.', 'The human resources team answers questions about employee benefits.'],
  ['missed deadline', 'What should happen when a committed delivery date cannot be met?', 'Notify the project owner and agree on a revised delivery date.', 'Project owners publish the original delivery schedule to the team.', 'The delivery team closes a task after the work is complete.'],
  ['license breach', 'Who reviews suspected use beyond the software agreement?', 'The software asset manager reviews suspected license overuse.', 'The procurement manager negotiates terms for a new software license.', 'IT support installs approved software on staff computers.'],
  ['customer complaint', 'Who owns a complaint that remains unresolved after support?', 'Escalated customer complaints are owned by the customer experience lead.', 'Support staff close a complaint after sending a standard response.', 'The account manager schedules quarterly customer reviews.'],
  ['late payment', 'Who follows up when a client has not paid an invoice?', 'Accounts receivable contacts clients about overdue invoices.', 'Accounts payable schedules outgoing vendor payments.', 'Sales staff prepare estimates before a customer places an order.'],
  ['hiring decision', 'Who makes the final choice after interview feedback is collected?', 'The hiring manager makes the final candidate selection after interviews.', 'Recruiters arrange candidate interviews and collect availability.', 'The interview panel submits independent feedback to the hiring manager.'],
  ['contract signature', 'Who checks an agreement before it is signed?', 'Legal counsel reviews contract language before an authorized officer signs.', 'The contract administrator stores executed agreements in the archive.', 'The sales representative prepares a proposal for the customer.'],
  ['travel disruption', 'Who helps a traveler when a booked flight is cancelled?', 'The travel desk helps staff rebook a cancelled business flight.', 'The department director approves international travel requests.', 'The expense team checks travel receipts after a trip.'],
  ['retention hold', 'What prevents routine deletion while a case is open?', 'A legal hold suspends normal document deletion until the case closes.', 'The records manager deletes documents after their retention period.', 'Case owners organize evidence in the matter workspace.'],
  ['access removal', 'When should a departing worker lose system access?', 'Disable system access on the employee departure date.', 'Managers request new account permissions for incoming staff.', 'The service desk resets passwords after identity verification.'],
  ['release rollback', 'Who decides whether a failed update should be reversed?', 'The release manager coordinates rollback when a production update fails.', 'Developers run tests before a production release.', 'The incident commander tracks user impact during an outage.'],
  ['quality defect', 'Where are repeated product defects sent for investigation?', 'Repeated quality defects are escalated to the manufacturing quality lead.', 'Warehouse staff isolate damaged stock before dispatch.', 'Customer support records product feedback from callers.'],
  ['budget variance', 'Who explains spending that is above the approved plan?', 'The budget owner explains and approves corrective action for a spending variance.', 'Finance publishes the approved annual budget to department leads.', 'Procurement compares supplier quotes before a purchase.'],
  ['confidential printout', 'What should happen to a sensitive page left at a shared printer?', 'Place uncollected confidential printouts in the secure disposal bin.', 'Facilities staff refill paper in shared office printers.', 'The records clerk archives signed paper agreements.'],
  ['meeting follow-up', 'Who is expected to deliver an agreed task after a meeting?', 'Each action item must name one owner responsible for its completion.', 'The meeting chair reserves a room for the next discussion.', 'The note taker distributes minutes to the attendees.'],
  ['duplicate payment', 'Who investigates when the same supplier bill appears twice?', 'Accounts payable investigates duplicate supplier invoice payments.', 'Accounts receivable follows up on unpaid customer balances.', 'Procurement creates a purchase order for a new supplier.'],
  ['emergency closure', 'Who communicates that staff should not come to the site?', 'The site lead sends the emergency closure notice to all staff.', 'Facilities reports routine building maintenance to employees.', 'Human resources publishes the annual holiday calendar.'],
  ['lost device', 'Who must be told when a work laptop goes missing?', 'Report a lost company laptop to the security response team immediately.', 'IT support configures replacement laptops for new employees.', 'The asset manager records equipment assigned to each worker.'],
  ['unapproved expense', 'Who reviews a purchase that exceeded the employee limit?', 'The department manager reviews expenses above the employee spending limit.', 'Finance reconciles approved expense claims each month.', 'Procurement negotiates discounts for recurring purchases.'],
  ['failed delivery', 'Who investigates a parcel marked delivered but not received?', 'The carrier claims desk investigates a delivery marked complete but missing.', 'The warehouse prints shipping labels before parcels leave.', 'Customer care provides estimated delivery dates for new orders.'],
  ['system permission', 'Who confirms that a user still needs a privileged role?', 'The system owner reviews privileged access during the quarterly access check.', 'The service desk creates a user account after manager approval.', 'Security investigates alerts from unusual account activity.'],
  ['expired certificate', 'Who renews a certificate before a service loses trust?', 'The platform administrator renews certificates before their expiration date.', 'The security team reviews certificate policy each year.', 'The service owner tests application behavior after a deployment.'],
  ['public statement', 'Who approves a response to a journalist?', 'The communications director approves statements to external media.', 'Legal counsel reviews contract language before signature.', 'Customer support replies to product questions from users.'],
  ['medical emergency', 'Who coordinates immediate help at the workplace?', 'Call the site emergency coordinator for a medical incident at work.', 'The safety officer reviews workplace hazards during inspections.', 'Human resources maintains employee benefit information.'],
  ['unusual login', 'Who assesses a sign-in from an unexpected location?', 'The security operations team investigates unusual account sign-ins.', 'The identity team issues access credentials to new employees.', 'The privacy office reviews requests to export personal information.'],
  ['change approval', 'Who must authorize a risky production change?', 'The change advisory group approves high-risk production changes.', 'The release manager records the time of a completed deployment.', 'Developers review source code before merging a change.'],
  ['records request', 'Who handles a request to obtain a copy of personal information?', 'The privacy response team coordinates personal data access requests.', 'The service desk helps users recover access to an account.', 'The records manager applies retention periods to archived files.'],
  ['supplier outage', 'Who tells internal teams that an external service is unavailable?', 'The service owner coordinates updates during a supplier outage.', 'Procurement reviews a supplier contract before renewal.', 'The incident commander manages outages in company systems.'],
  ['workplace injury', 'What record is required after an employee is hurt at work?', 'Document workplace injuries in the safety incident register.', 'Facilities logs repairs to doors and office equipment.', 'Human resources tracks leave requests after an injury.'],
  ['unplanned absence', 'Who should be told first when a scheduled worker cannot attend?', 'Notify the shift supervisor when a scheduled worker is absent.', 'The department director approves planned employee travel.', 'Payroll reviews recorded hours at the end of a pay period.'],
  ['unreadable report', 'Who restores access when a shared file cannot be opened?', 'The workspace owner restores permissions on a shared report.', 'The author edits report content before it is published.', 'The service desk unlocks user accounts after identity checks.'],
  ['renewal negotiation', 'Who discusses revised terms before a supplier agreement ends?', 'The contract owner leads renewal negotiations before the agreement expires.', 'Legal counsel reviews the final contract language before signature.', 'Accounts payable processes invoices under the current agreement.'],
  ['unanswered escalation', 'Who takes over when a support issue misses its response target?', 'The support manager takes ownership of an escalation that misses its response target.', 'The customer experience lead reviews recurring complaint themes.', 'The incident commander coordinates a confirmed production outage.'],
];
assert.equal(hard.length, 40, 'Hard denominator is fixed at 40 before scoring.');
for (const [topic, question, answer, distractorA, distractorB] of hard) {
  const target = await note(`Hard ${topic} answer`, answer);
  await note(`Hard ${topic} competing A`, distractorA);
  await note(`Hard ${topic} competing B`, distractorB);
  add('Hard', question, [target]);
}

// XLING: equivalent queries in four languages over English-only answer notes.
// No shared identifiers are injected; failures are meaningful for this lexical engine.
const xling = [
  ['¿Quién autoriza una devolución excepcional?', 'A regional manager may approve a refund outside the normal return policy.'],
  ['Où sont archivés les accords signés ?', 'Store signed contracts in the legal archive.'],
  ['Chi coordina il ripristino dopo un guasto?', 'The recovery lead coordinates restoring service from the latest backup.'],
  ['Wer genehmigt eine internationale Geschäftsreise?', 'A department director must approve international travel.'],
  ['¿Cuándo deben borrarse los registros vencidos?', 'Records are deleted when their approved retention period expires.'],
  ['Qui examine une facture payée deux fois ?', 'Accounts payable investigates duplicate supplier invoice payments.'],
  ['Dove si segnala un pericolo sul posto di lavoro?', 'Employees report workplace safety hazards to the site safety officer.'],
  ['Wer untersucht eine ungewöhnliche Anmeldung?', 'The security operations team investigates unusual account sign-ins.'],
  ['¿Quién aprueba un cambio de producción de alto riesgo?', 'The change advisory group approves high-risk production changes.'],
  ['Où demander une copie de ses données personnelles ?', 'The privacy response team coordinates personal data access requests.'],
  ['Chi contatta il cliente per una fattura scaduta?', 'Accounts receivable contacts clients about overdue invoices.'],
  ['Wer entscheidet über die Auswahl nach den Gesprächen?', 'The hiring manager makes the final candidate selection after interviews.'],
  ['¿Quién comunica el cierre de emergencia de una sede?', 'The site lead sends the emergency closure notice to all staff.'],
  ['Où signaler la perte d’un ordinateur professionnel ?', 'Report a lost company laptop to the security response team immediately.'],
  ['Chi negozia le condizioni prima della scadenza del contratto?', 'The contract owner leads renewal negotiations before the agreement expires.'],
  ['Wer übernimmt einen ungelösten Supportfall?', 'The support manager takes ownership of an escalation that misses its response target.'],
  ['¿Quién revisa el gasto que supera el límite?', 'The department manager reviews expenses above the employee spending limit.'],
  ['Où déclarer une blessure survenue au travail ?', 'Document workplace injuries in the safety incident register.'],
  ['Chi aiuta a riprenotare un volo cancellato?', 'The travel desk helps staff rebook a cancelled business flight.'],
  ['Wer erneuert ein Zertifikat vor seinem Ablauf?', 'The platform administrator renews certificates before their expiration date.'],
];
assert.equal(xling.length, 20, 'XLING denominator is fixed at 20 before scoring.');
for (let i = 0; i < xling.length; i += 1) {
  const [question, answer] = xling[i];
  const target = await note(`XLING English answer ${i + 1}`, answer);
  add('XLING', question, [target]);
}

// Simple no-hit traps still test engine abstention on truly absent vocabulary.
for (let i = 1; i <= 10; i += 1) add('Trap-nohit', `absentfixture${i} nowherefixture${i}`, [], {
  trap: true,
  variants: [`quietartifact${i} violetfixture${i}`],
});

// Plausible traps intentionally retrieve nearby but non-answering notes. This test
// labels the absent answer mechanically and records candidate exposure; the MCP search
// engine cannot judge whether Claude should abstain, so that behavior remains untested.
const plausibleTraps = [
  ['Which team authorizes a payroll refund?', 'Who approves a refund tied to employee pay?', 'The payroll clerk corrects an employee salary deduction.', 'The billing team reviews card refunds for customers.'],
  ['Who approves access to a customer medical file?', 'Which role grants access to a customer medical record?', 'The records team schedules deletion of expired customer files.', 'The security team reviews privileged access to company systems.'],
  ['Where do workers report a road accident during a business trip?', 'How should someone report a traffic collision while traveling for work?', 'The travel desk helps rebook cancelled flights.', 'The safety officer reviews injuries at the office site.'],
  ['Who signs off a supplier payment exception?', 'Who approves an exception to supplier payment rules?', 'Accounts payable investigates duplicate supplier payments.', 'A regional manager approves exceptions to the customer refund policy.'],
  ['What is the deadline to erase an archived contract?', 'By when must an archived agreement be destroyed?', 'The legal archive stores signed contracts.', 'Records are removed after the retention period expires.'],
  ['Who handles a package theft reported by an employee?', 'Which team investigates an employee report of stolen delivery?', 'The carrier claims desk investigates missing deliveries.', 'The security team investigates missing company laptops.'],
  ['Who can change a hiring interview score after submission?', 'Can an interview rating be edited after it is submitted?', 'The hiring panel submits feedback after interviews.', 'The change advisory group approves production changes.'],
  ['Where is a private access request escalated?', 'To whom should a private access escalation be sent?', 'The privacy response team coordinates personal data access requests.', 'The service desk resets locked accounts.'],
  ['Who authorizes a building closure for routine repairs?', 'Who approves closing a building for scheduled maintenance?', 'The site lead sends emergency closure notices.', 'Facilities staff handle routine office repairs.'],
  ['Who reviews a certificate renewal invoice?', 'Which team checks billing for a certificate renewal?', 'The platform administrator renews expiring certificates.', 'Accounts payable reviews supplier invoices before payment.'],
];
for (const [question, variant, wrongA, wrongB] of plausibleTraps) {
  await note(`Plausible trap candidate ${slug(question)} A`, wrongA);
  await note(`Plausible trap candidate ${slug(question)} B`, wrongB);
  add('Trap-plausible', question, [], { trap: true, plausible: true, variants: [variant] });
}

const answerRows = rows.filter(row => !row.trap);
assert.equal(variantFixture.size, answerRows.length, 'query-variant fixture must have one row per answer-bearing question');
for (const row of answerRows) {
  const fixture = variantFixture.get(row.id);
  assert(fixture, `missing frozen query variants for ${row.id}`);
  assert.equal(fixture.stratum.toUpperCase(), row.stratum.toUpperCase(), `stratum mismatch for ${row.id}`);
  assert.equal(fixture.question, row.question, `question mismatch for ${row.id}`);
  assert.equal(fixture.variants.length, row.stratum === 'XLING' ? 1 : 2, `unexpected variant count for ${row.id}`);
}

// Assert this evaluation contains no generated answer token shortcuts.
for (const row of rows.filter(value => !value.trap)) {
  assert(!/(?:easyanchor|mediumanchor|hardanchor|hardproof|easyrecord|mediumcode|accorddate|mandate\d|register\d)\d*/i.test(row.question), `synthetic unique-token shortcut in ${row.stratum}: ${row.question}`);
}

try {
  const build = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-index.sh')], { encoding: 'utf8', env });
  assert.equal(build.status, 0, `build-index.sh failed: ${build.stderr || build.stdout}`);
  const extraction = spawnSync('/bin/bash', [path.join(engine, 'bin', 'extract.sh')], { encoding: 'utf8', env });
  assert.equal(extraction.status, 0, `extract.sh failed: ${extraction.stderr || extraction.stdout}`);
  const indexText = await fs.readFile(path.join(moc, 'index.tsv'), 'utf8');
  const indexedKeywords = new Map(indexText.split('\n').filter(line => line && !line.startsWith('#'))
    .map(line => line.split('\t')).map(([source, , , keywords]) => [path.basename(source), keywords]));
  const evaluatedTargets = [...new Set(rows.filter(row => !row.trap).flatMap(row => row.expected))];
  const missingKeywords = evaluatedTargets.filter(target => !indexedKeywords.get(target) || indexedKeywords.get(target) === '-');
  assert.equal(missingKeywords.length, 0, `full setup failed to record derived search keywords for ${missingKeywords.join(', ')}`);
  assert.equal((await fs.readdir(path.join(moc, 'extracted'))).length, 0, 'local Markdown keyword selection must not create duplicate body sidecars');
  for (const [filename, expectedDigest] of originalDigests) {
    const actualDigest = createHash('sha256').update(await fs.readFile(path.join(corpus, filename))).digest('hex');
    assert.equal(actualDigest, expectedDigest, `setup changed original file ${filename}`);
  }
  const fts = spawnSync('/bin/bash', [path.join(engine, 'bin', 'build-fts.sh')], { encoding: 'utf8', env });
  assert.equal(fts.status, 0, `build-fts.sh failed: ${fts.stderr || fts.stdout}`);
  const rawSearch = query => {
    const result = spawnSync('/bin/bash', [path.join(engine, 'bin', 'fts.sh'), query, '3'], { encoding: 'utf8', env });
    assert.equal(result.status, 0, `fts.sh failed for ${query}: ${result.stderr}`);
    const ranked = [...result.stdout.matchAll(/^\s*\d+\s+[-\d.]+\s+(.+)$/gm)].map(match => path.basename(match[1].trim()));
    return { ranked, output: result.stdout };
  };
  const rawCounts = new Map();
  const variantCounts = new Map();
  const rawRowHits = new Map();
  const failures = [];
  const rawTrapResults = [];
  for (const row of rows) {
    const { ranked, output } = rawSearch(row.question);
    if (row.trap) {
      const exposed = ranked.length > 0;
      rawTrapResults.push({ kind: row.plausible ? 'plausible' : 'no-hit', exposed, ranked, question: row.question });
      continue;
    }
    const metric = rawCounts.get(row.stratum) ?? { hits: 0, total: 0 };
    const hit = row.expected.some(expected => ranked.includes(expected));
    rawRowHits.set(row.id, hit);
    metric.hits += Number(hit);
    metric.total += 1;
    rawCounts.set(row.stratum, metric);
  }

  await fs.mkdir(path.join(temp, 'mcp-home'), { recursive: true });
  const serverHome = await fs.realpath(path.join(temp, 'mcp-home'));
  const desktop = path.join(serverHome, 'Desktop');
  const dataHome = path.join(desktop, 'DataBrain');
  await fs.mkdir(desktop, { recursive: true });
  server = spawn(process.execPath, [path.join(engine, 'setup/mcp/server.mjs')], {
    env: { ...process.env, HOME: serverHome, DATABRAIN_ENGINE_DIR: engine,
      DATABRAIN_TEST_HOME: dataHome, DATABRAIN_TEST_PARENT: desktop,
      DATABRAIN_TEST_SOURCE_ROOTS: JSON.stringify([await fs.realpath(corpus)]),
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const replies = new Map();
  let serverStderr = '';
  server.stderr.setEncoding('utf8');
  server.stderr.on('data', part => { serverStderr += part; });
  readline.createInterface({ input: server.stdout }).on('line', line => {
    const message = JSON.parse(line);
    if (message.id !== undefined) replies.get(message.id)?.(message);
  });
  let requestId = 0;
  function request(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++requestId;
      const timer = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`Timed out waiting for ${method}; server stderr: ${serverStderr}`));
      }, 30000);
      replies.set(id, message => {
        clearTimeout(timer);
        replies.delete(id);
        if (message.error) reject(new Error(`${method}: ${message.error.message}`));
        else resolve(message.result);
      });
      server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }
  async function call(name, args = {}) {
    const result = await request('tools/call', { name, arguments: args });
    const text = result?.content?.find(block => block.type === 'text')?.text ?? '';
    assert(!result?.isError && !text.startsWith('DataBrain: '), `${name} failed: ${text}`);
    return text;
  }
  async function waitForStatus(predicate, description) {
    let last = '';
    for (let i = 0; i < 600; i += 1) {
      last = await call('databrain_setup_status');
      if (predicate(last)) return last;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`Timed out waiting for ${description}; last status: ${last}`);
  }
  function rankedPaths(route) {
    return [...route.matchAll(/^\s*\d+\s+-?\d+(?:\.\d+)?\s+(.+)$/gm)]
      .map(match => path.basename(match[1].trim()));
  }
  await request('initialize', {
    protocolVersion: '2025-03-26', capabilities: {},
    clientInfo: { name: 'synthetic-recall-exam', version: '1' },
  });
  server.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  await call('databrain_setup_start');
  await waitForStatus(status => status.includes('Stage: sources selected.'), 'disposable source authorization');
  // Reuse the one built disposable engine index. MCP creates its own temporary
  // authorization state above; this avoids indexing the same 200 synthetic files twice.
  const mcpMoc = path.join(dataHome, 'moc');
  await fs.mkdir(mcpMoc, { recursive: true });
  await fs.copyFile(path.join(moc, 'index.tsv'), path.join(mcpMoc, 'index.tsv'));
  await fs.copyFile(path.join(moc, 'fts.db'), path.join(mcpMoc, 'fts.db'));

  for (const row of answerRows) {
    const fixture = variantFixture.get(row.id);
    const queries = [row.question, ...fixture.variants];
    assert.equal(new Set(queries.map(query => query.toLowerCase())).size, queries.length, `duplicate query variants for ${row.id}`);
    const route = await call('databrain_abstain_check', { queries });
    assert.match(route, /Reading route only; not an answer or absence verdict/);
    assert.match(route, /Read relevant evidence with databrain_read before answering or abstaining/);
    const ranked = rankedPaths(route);
    const hit = row.expected.some(expected => ranked.includes(expected));
    const metric = variantCounts.get(row.stratum) ?? { hits: 0, total: 0 };
    metric.hits += Number(hit);
    metric.total += 1;
    variantCounts.set(row.stratum, metric);
    process.stdout.write(`ROW ${row.id}: raw=${rawRowHits.get(row.id) ? 'hit' : 'miss'}; variant-union=${hit ? 'hit' : 'miss'}; candidates=${ranked.length}\n`);
  }

  const trapResults = [];
  for (const row of rows.filter(value => value.trap)) {
    const queries = [row.question, ...row.variants];
    assert.equal(new Set(queries.map(query => query.toLowerCase())).size, queries.length, `duplicate trap variants for ${row.id}`);
    const route = await call('databrain_abstain_check', { queries });
    const ranked = rankedPaths(route);
    const exposed = ranked.length > 0;
    const dry = /DRY —/.test(route);
    const readFirst = /Read relevant evidence with databrain_read before answering or abstaining/.test(route);
    trapResults.push({ kind: row.plausible ? 'plausible' : 'no-hit', exposed, dry, readFirst, ranked });
    if (!row.plausible && (exposed || !dry || !/Do not answer from DataBrain/.test(route))) {
      failures.push(`all-absent MCP variants did not remain DRY for ${row.id}: ${ranked.join(', ') || 'no candidates'}`);
    }
    if (row.plausible && (!exposed || dry || !readFirst || !/Reading route only; not an answer or absence verdict/.test(route))) {
      failures.push(`plausible trap did not remain read-first for ${row.id}: ${ranked.join(', ') || 'no candidates'}`);
    }
  }

  const bars = { Easy: [10, 10], Medium: [10, 10], Hard: [32, 40], XLING: [16, 20] };
  process.stdout.write(`Synthetic full-pipeline keyword selection: ${evaluatedTargets.length}/${evaluatedTargets.length} answer-bearing files received derived search keywords.\n`);
  process.stdout.write('Raw single-query baseline (diagnostic only; original recall bars remain scored on the MCP variant workflow):\n');
  for (const [stratum, [minimum, denominator]] of Object.entries(bars)) {
    const metric = rawCounts.get(stratum) ?? { hits: 0, total: 0 };
    process.stdout.write(`${stratum}: ${metric.hits}/${metric.total}; required ${minimum}/${denominator}; ${metric.total === denominator && metric.hits >= minimum ? 'PASS' : 'FAIL'}\n`);
  }
  process.stdout.write('MCP databrain_abstain_check variant-union recall (synthetic only; not held-out or Claude answer-quality acceptance):\n');
  for (const [stratum, [minimum, denominator]] of Object.entries(bars)) {
    const metric = variantCounts.get(stratum) ?? { hits: 0, total: 0 };
    process.stdout.write(`${stratum}: ${metric.hits}/${metric.total}; required ${minimum}/${denominator}; ${metric.total === denominator && metric.hits >= minimum ? 'PASS' : 'FAIL'}\n`);
    if (metric.total !== denominator || metric.hits < minimum) failures.push(`${stratum} variant-union recall below bar: ${metric.hits}/${metric.total}; required ${minimum}/${denominator}`);
  }
  const simpleTraps = trapResults.filter(result => result.kind === 'no-hit');
  const plausible = trapResults.filter(result => result.kind === 'plausible');
  const rawNoHit = rawTrapResults.filter(result => result.kind === 'no-hit');
  const rawPlausible = rawTrapResults.filter(result => result.kind === 'plausible');
  process.stdout.write(`Raw traps: no-hit ${rawNoHit.filter(result => !result.exposed).length}/${rawNoHit.length} empty; plausible candidates surfaced ${rawPlausible.filter(result => result.exposed).length}/${rawPlausible.length}.\n`);
  process.stdout.write(`MCP traps: no-hit ${simpleTraps.filter(result => !result.exposed && result.dry).length}/${simpleTraps.length} DRY; plausible candidates surfaced/read-first ${plausible.filter(result => result.exposed && !result.dry && result.readFirst).length}/${plausible.length}.\n`);
  if (failures.length) {
    process.stderr.write(`Failures (${failures.length}):\n${failures.map(failure => `- ${failure}`).join('\n')}\n`);
    process.exitCode = 1;
  }
  process.stdout.write('Score is top-3 lexical file retrieval through the MCP query-variant tool. Frozen variants contain only questions and paraphrases/translations; they contain no answer text or expected paths. This does not test Claude-generated variants, answer correctness, citations, or Claude\'s judgment of read evidence; synthetic success cannot replace the private held-out judge-model exam.\n');
} finally {
  if (server) {
    server.kill('SIGTERM');
    if (server.exitCode === null) await new Promise(resolve => server.once('exit', resolve));
  }
  await fs.rm(temp, { recursive: true, force: true });
}
