// Regression test for CONCIERGE_REGEX in src/server.js.
// Extracts the live regex definition from source (no copy) and asserts the
// access-detection battery, including the "didn't receive / never sent the form"
// phrasings added on 2026-06-01. Run: node scripts/test-concierge-regex.js
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const m = src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/);
if (!m) { console.error('Could not locate CONCIERGE_REGEX in src/server.js'); process.exit(2); }
// eslint-disable-next-line no-eval
const CONCIERGE_REGEX = eval('new RegExp(' + m[1] + '\n)');

const SHOULD_MATCH = [
  // pre-existing coverage
  'The front desk wont let me in',
  'They said the check-in form was not sent',
  'front desk needs a form before they let me up',
  "the building won't let me access the elevator",
  "Security won't let me come up",
  'They have no reservation under my name',
  "I'm at the lobby and they can't find my booking",
  'reception says I\'m not in the system',
  'guard is asking for authorization',
  "elevator requires a key and I can't get to my floor",
  // newly added "form never sent / not received" phrasings
  'the form was never sent to the front desk',
  "I didn't receive the form",
  'I never received the form',
  'you never sent me the form',
  'the front desk never got my form',
  'no one sent the form to the building',
  "haven't received the check-in form",
];

const SHOULD_NOT_MATCH = [
  'Can I check in early at 1pm?',
  'What is the wifi password?',
  'Can I check-in early tomorrow?',
  'Is there parking nearby?',
  'What time is checkout?',
  'Can I get in around 3?',
  // form mentioned but no problem — must NOT fire
  'Is there a form I should fill out?',
  'Do I need to complete a form before arrival?',
  "I filled out the form already, can't wait to arrive!",
  // 2026-06-09 FALSE-FIRE regression — Ashley (7-B). A normal pre-arrival question about
  // WHEN check-in details arrive / HOW to access the building is NOT a front-desk failure.
  // (Previously matched line 1031 via details + sending + building.)
  'When will you be sending out the details for the stay? Like the address and how to access the building.',
  'When will you send me the check-in details?',
  'How do I access the building?',
  "What's the address?",
  'When are you sending the details for my stay?',
];

let failed = 0;
console.log('=== SHOULD MATCH ===');
for (const s of SHOULD_MATCH) {
  const ok = CONCIERGE_REGEX.test(s.toLowerCase());
  console.log(`${ok ? '✓' : '✗ MISS'}  ${s}`);
  if (!ok) failed++;
}
console.log('\n=== SHOULD NOT MATCH ===');
for (const s of SHOULD_NOT_MATCH) {
  const bad = CONCIERGE_REGEX.test(s.toLowerCase());
  console.log(`${bad ? '✗ FALSE POSITIVE' : '✓ ignored'}  ${s}`);
  if (bad) failed++;
}

const total = SHOULD_MATCH.length + SHOULD_NOT_MATCH.length;
console.log(`\nRESULT: ${total - failed}/${total} passed`);
process.exit(failed === 0 ? 0 : 1);
