// Front-desk / concierge authorization email: a formal note from Yasser Khan, then a clean
// labeled list of the guest's reservation details (values filled in next to each label), in
// this exact order: Name of guest, Arrival & Departure Dates, Unit Number, Arrival Time,
// Number of guests, The person authorizing the stay (= Yasser Khan, fixed).
// buildConciergeEmail is pure so the body is unit-testable (no send).
// Run: node scripts/test-concierge-email.js
const assert = require('assert');
const { buildConciergeEmail } = require('../src/concierge-email');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

const sample = {
  guestName: 'Dekarius Pitts',
  unitLabel: '24-L',
  checkIn: '2026-06-03',
  checkOut: '2026-06-06',
  arrivalTime: '4:00 PM',
  numGuests: 2,
  code: 'HMFTKY3AZM',
};

check('opens with the formal note from Yasser Khan + legitimacy disclaimer', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(/^Hello, this is Yasser Khan\./.test(body.trim()), `note missing/at-wrong-place:\n${body}`);
  assert.ok(/formally requesting that the following guest be granted access/i.test(body), 'missing formal-request wording');
  assert.ok(/legitimate, authorized check-in request — not spam or a phishing attempt/i.test(body), 'missing anti-spam disclaimer');
});

check('each label shows the REAL value next to it (incl. confirmation code)', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(body.includes('Name of guest: Dekarius Pitts'), 'name not populated');
  assert.ok(body.includes('Arrival & Departure Dates: 2026-06-03 – 2026-06-06'), 'dates not populated');
  assert.ok(body.includes('Unit Number: 24-L'), 'unit not populated');
  assert.ok(body.includes('Confirmation Code: HMFTKY3AZM'), 'confirmation code not populated');
  assert.ok(body.includes('Arrival Time: 4:00 PM'), 'arrival time not populated');
  assert.ok(body.includes('Number of guests: 2'), 'guest count not populated');
  assert.ok(body.includes('The person authorizing the stay: Yasser Khan'), 'authorizer not populated');
});

check('missing code degrades to N/A', () => {
  const { body } = buildConciergeEmail({ ...sample, code: null });
  assert.ok(/Confirmation Code: N\/A/.test(body), 'code should fall back to N/A');
});

check('labels appear in the exact required order', () => {
  const { body } = buildConciergeEmail(sample);
  const order = ['Name of guest:', 'Arrival & Departure Dates:', 'Unit Number:', 'Confirmation Code:', 'Arrival Time:', 'Number of guests:', 'The person authorizing the stay:'];
  const idx = order.map(l => body.indexOf(l));
  assert.ok(idx.every(i => i >= 0), `a label is missing: ${JSON.stringify(idx)}`);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `order wrong at "${order[i]}"`);
});

check('authorizer is FIXED to Yasser Khan (ignores any passed value)', () => {
  const { body } = buildConciergeEmail({ ...sample, authorizer: 'Someone Else' });
  assert.ok(body.includes('The person authorizing the stay: Yasser Khan'), 'authorizer must be fixed');
  assert.ok(!body.includes('Someone Else'), 'must not use a passed authorizer');
});

check('missing arrival time / guest count degrade to a default, still builds', () => {
  const { body } = buildConciergeEmail({ ...sample, arrivalTime: null, numGuests: null });
  assert.ok(/Arrival Time: .+/.test(body), 'arrival time line must still render');
  assert.ok(/Number of guests: .+/.test(body), 'guest count line must still render');
});

check('returns { subject, body } strings', () => {
  const out = buildConciergeEmail(sample);
  assert.strictEqual(typeof out.subject, 'string');
  assert.strictEqual(typeof out.body, 'string');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
