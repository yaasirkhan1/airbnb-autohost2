// Front-desk / concierge authorization email: a formal note from Yasser Khan, then a clean
// labeled list of the guest's reservation details (values filled in next to each label), then
// a closing. Dates render as readable "Weekday, Month D, YYYY"; arrival time is pulled from the
// check-in timestamp; the email ships an HTML body so line breaks survive in real mail clients.
// buildConciergeEmail is pure so the output is unit-testable (no send).
// Run: node scripts/test-concierge-email.js
const assert = require('assert');
const { buildConciergeEmail } = require('../src/concierge-email');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// Real reservations arrive as full ISO timestamps (with offset), not date-only strings.
const sample = {
  guestName: 'Dekarius Pitts',
  unitLabel: '24-L',
  checkIn:  '2026-06-20T16:00:00-04:00',
  checkOut: '2026-06-27T11:00:00-04:00',
  numGuests: 2,
};

check('dates render as readable "Weekday, Month D, YYYY" — never raw timestamps', () => {
  const { body, html } = buildConciergeEmail(sample);
  assert.ok(body.includes('Saturday, June 20, 2026'), 'arrival date not readable');
  assert.ok(body.includes('Saturday, June 27, 2026'), 'departure date not readable');
  assert.ok(!/\d{4}-\d{2}-\d{2}T/.test(body) && !/\d{4}-\d{2}-\d{2}T/.test(html), 'raw ISO timestamp leaked into output');
  assert.ok(body.includes('Arrival & Departure Dates: Saturday, June 20, 2026 – Saturday, June 27, 2026'), 'dates line wrong');
});

check('arrival time is pulled from the check-in timestamp (16:00 -> 4:00 PM)', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(body.includes('Arrival Time: 4:00 PM'), `arrival time not derived from timestamp:\n${body}`);
});

check('date-only check-in still formats; arrival time falls back to 4:00 PM', () => {
  const { body } = buildConciergeEmail({ ...sample, checkIn: '2026-06-03', checkOut: '2026-06-06' });
  assert.ok(body.includes('Wednesday, June 3, 2026'), 'date-only arrival not readable');
  assert.ok(body.includes('Saturday, June 6, 2026'), 'date-only departure not readable');
  assert.ok(body.includes('Arrival Time: 4:00 PM'), 'arrival time should default when no time in timestamp');
});

check('opens with the Yasser Khan note + anti-spam disclaimer; closes with a sign-off', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(/^Hello, this is Yasser Khan\./.test(body.trim()), 'note missing/at wrong place');
  assert.ok(/legitimate, authorized check-in request — not spam or a phishing attempt/i.test(body), 'missing anti-spam disclaimer');
  assert.ok(/Thank you,[\s\S]*Yasser Khan/.test(body), 'missing closing sign-off');
});

check('layout: note paragraph, blank line, each field on its OWN line, blank line, closing', () => {
  const { body } = buildConciergeEmail(sample);
  // a blank line after the note and before the closing (paragraph separation)
  assert.ok(/below\.\n\nName of guest:/.test(body), 'no blank line between note and details');
  assert.ok(/Yasser Khan\n\nThank you,/.test(body), 'no blank line between details and closing');
  // each detail on its own line (newline-separated, not crammed)
  assert.ok(/Name of guest: .+\nArrival & Departure Dates: .+\nUnit Number: .+\n/.test(body), 'fields not on their own lines');
});

check('ships an HTML body with real line breaks (<br>) and paragraphs (<p>)', () => {
  const { html } = buildConciergeEmail(sample);
  assert.strictEqual(typeof html, 'string');
  assert.ok(/<p>/.test(html) && /<br\s*\/?>/.test(html), 'html must use <p> and <br> so lines do not collapse');
  assert.ok(/Name of guest: Dekarius Pitts<br\s*\/?>/.test(html), 'html field line must end in <br>');
  assert.ok(/Arrival &amp; Departure Dates:/.test(html), 'ampersand must be HTML-escaped');
});

check('each label shows the REAL value next to it', () => {
  const { body } = buildConciergeEmail(sample);
  assert.ok(body.includes('Name of guest: Dekarius Pitts'), 'name not populated');
  assert.ok(body.includes('Unit Number: 24-L'), 'unit not populated');
  assert.ok(body.includes('Number of guests: 2'), 'guest count not populated');
  assert.ok(body.includes('The person authorizing the stay: Yasser Khan'), 'authorizer not populated');
});

check('Confirmation Code line is removed entirely (body + html)', () => {
  const { subject, body, html } = buildConciergeEmail(sample);
  assert.ok(!/confirmation code/i.test(body), 'Confirmation Code must not appear in the body');
  assert.ok(!/confirmation code/i.test(html), 'Confirmation Code must not appear in the html');
  assert.ok(!/confirmation code/i.test(subject), 'Confirmation Code must not appear in the subject');
});

check('labels appear in the exact required order', () => {
  const { body } = buildConciergeEmail(sample);
  const order = ['Name of guest:', 'Arrival & Departure Dates:', 'Unit Number:', 'Arrival Time:', 'Number of guests:', 'The person authorizing the stay:'];
  const idx = order.map(l => body.indexOf(l));
  assert.ok(idx.every(i => i >= 0), `a label is missing: ${JSON.stringify(idx)}`);
  for (let i = 1; i < idx.length; i++) assert.ok(idx[i] > idx[i - 1], `order wrong at "${order[i]}"`);
});

check('authorizer is FIXED to Yasser Khan (ignores any passed value)', () => {
  const { body } = buildConciergeEmail({ ...sample, authorizer: 'Someone Else' });
  assert.ok(body.includes('The person authorizing the stay: Yasser Khan'), 'authorizer must be fixed');
  assert.ok(!body.includes('Someone Else'), 'must not use a passed authorizer');
});

check('returns { subject, body, html } strings', () => {
  const out = buildConciergeEmail(sample);
  for (const k of ['subject', 'body', 'html']) assert.strictEqual(typeof out[k], 'string', `${k} must be a string`);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
