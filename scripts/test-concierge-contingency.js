// Proves the front-desk/concierge contingency (CONCIERGE_REGEX) fires for the
// REAL guest phrasings from tonight's logs, and does NOT fire for a normal
// question. Run: node scripts/test-concierge-contingency.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const m = src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/);
assert.ok(m, 'could not locate CONCIERGE_REGEX in server.js');
const CONCIERGE_REGEX = eval('new RegExp(' + m[1] + '\n)');

// The four actual guest messages from tonight's logs that SHOULD have fired the
// front-desk email contingency (sendConciergeEmail) but did not:
const SHOULD_FIRE = [
  'Can you send my reservation over to the concierge?',                                   // send reservation → concierge
  'send the reservation over to the front desk',                                          // send reservation → front desk (explicit)
  'I need you to send over the reservation to the front desk and get me the entry code',  // still fires via send-reservation (NOT via entry-code)
  'the front desk doesn’t have my reservation',                                            // desk doesn't have it / needs to confirm
];

// Control(s): normal guest questions that must NOT trigger the contingency.
const SHOULD_NOT_FIRE = [
  'what time is checkout?',            // the named control
  'what’s the wifi password?',
  'can I check in early at 1pm?',
  'I don’t have my reservation number handy, can you resend it?', // 1st-person, NOT a front-desk problem
  'Hey, Cal. Just arrived. Do you have an entry code for me?',    // entry-code: must NOT fire (Hospitable handles codes)
  'Front desk told me I’m supposed to have a fob up here for getting in and out of the building.', // fob: must NOT fire
];

let fail = 0;
console.log('=== SHOULD FIRE (front-desk email contingency) ===');
for (const s of SHOULD_FIRE) {
  const ok = CONCIERGE_REGEX.test(s.toLowerCase());
  console.log(`${ok ? '✓ fires ' : '✗ MISS  '} ${s}`);
  if (!ok) fail++;
}
console.log('\n=== SHOULD NOT FIRE (normal messages) ===');
for (const s of SHOULD_NOT_FIRE) {
  const bad = CONCIERGE_REGEX.test(s.toLowerCase());
  console.log(`${bad ? '✗ FALSE POSITIVE' : '✓ ignored'} ${s}`);
  if (bad) fail++;
}

const total = SHOULD_FIRE.length + SHOULD_NOT_FIRE.length;
console.log(`\nRESULT: ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
