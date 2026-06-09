// Money/refund complaint guard: when a guest complaint involves a refund, compensation,
// money, a dispute, "had to pay", or "cost me", the responder must NOT auto-reply (it
// over-promised "coordinating with Airbnb … I'll follow up" on Ashley Marrow's hotel-cost
// complaint). Those messages escalate to the host (SMS) and stay SILENT to the guest.
// isMoneyComplaint is the pure detector. Run: node scripts/test-money-complaint.js
const assert = require('assert');
const { isMoneyComplaint } = require('../src/server.js');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// MUST escalate (host SMS) + stay silent to guest
const ESCALATE = [
  // Ashley Marrow's exact message (2026-06-09 over-promise incident)
  'I didn’t stay there on the 28th I had to get a hotel room which cost me more money then I expected because of your set expectations!',
  'I want a refund for this stay.',
  'Do you offer refunds?',
  'This cost me money and I expect compensation.',
  'I had to pay for a hotel because I couldn’t check in.',
  'I had to book another place last minute.',
  'I’m going to dispute this charge with my bank.',
  'Please reimburse me for the extra costs.',
  'I’m out of pocket because of this.',
  'I want my money back.',
  'You owe me for the night I lost.',
];

// MUST NOT be silenced — normal questions / non-money complaints (Claude handles these)
const REPLY = [
  'What time is check-in?',
  'Is there parking nearby?',
  'The AC isn’t working, can you help?',          // a complaint, but not about money
  'How much is the cleaning fee?',                 // asks about money, not a refund/complaint
  'Do you have an ATM nearby to get some cash money?',
  'Can I get a late checkout?',
  'I had to get the door code from the last guest', // "had to get" but no lodging/cost object
];

check('Ashley + refund/compensation/dispute/"cost me"/"had to pay" → escalate', () => {
  for (const m of ESCALATE) assert.ok(isMoneyComplaint(m), `should escalate: "${m}"`);
});

check('normal questions + non-money complaints → NOT silenced', () => {
  for (const m of REPLY) assert.ok(!isMoneyComplaint(m), `should NOT escalate: "${m}"`);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
