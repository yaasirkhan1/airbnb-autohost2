// Fix 1 — the front-desk email must include the reservation CONFIRMATION CODE
// alongside name / unit / check-in / check-out, pulled from the real reservation.
// buildConciergeEmail is a pure function so the body is unit-testable (no send).
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
  code: 'HMFTKY3AZM',
};

check('body includes the confirmation code', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(body.includes('HMFTKY3AZM'), `code missing from body:\n${body}`);
  assert.ok(/confirmation code/i.test(body), 'should be labeled as a confirmation code');
});

check('body still includes name, unit, check-in, check-out', () => {
  const { body } = buildConciergeEmail(sample);
  for (const v of ['Dekarius Pitts', '24-L', '2026-06-03', '2026-06-06'])
    assert.ok(body.includes(v), `missing "${v}" in body`);
});

check('subject includes unit and dates', () => {
  const { subject } = buildConciergeEmail(sample);
  assert.ok(subject.includes('24-L'), 'subject missing unit');
  assert.ok(subject.includes('2026-06-03') && subject.includes('2026-06-06'), 'subject missing dates');
});

check('missing code degrades gracefully to N/A (still builds, no throw)', () => {
  const { body } = buildConciergeEmail({ ...sample, code: null });
  assert.ok(/confirmation code:\s*N\/A/i.test(body), `expected N/A code, got:\n${body}`);
});

check('returns { subject, body } strings', () => {
  const out = buildConciergeEmail(sample);
  assert.strictEqual(typeof out.subject, 'string');
  assert.strictEqual(typeof out.body, 'string');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
