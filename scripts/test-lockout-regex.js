// Lockout handler coverage (server.js:1340). The hardcoded lockout reply ("call/text
// 954-552-2122") must fire on an ACTIVE entry failure — including door-code / keypad
// malfunctions that the front-desk concierge classifier deliberately excludes — but must
// STAY OUT of normal questions that merely mention the code/keypad/door.
// Run: node scripts/test-lockout-regex.js
'use strict';
const assert = require('assert');
const { detectHardcodedResponse } = require('../src/server');

const PHONE = '954-552-2122';
const firesLockout = (msg) => {
  const r = detectHardcodedResponse('Sam', msg);
  return !!(r && r.reply && r.reply.includes(PHONE));
};

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// MUST fire the instant lockout reply — active entry failures.
const FIRE = [
  "I'm standing outside and the code isn't working",
  "the code won't work",
  "the entry code isn't working",
  "the keypad just beeps red",
  "keypad is flashing red",
  "the door won't open",
  "the lock isn't working",
  "can't get the door open",
  "the keypad is broken",
  // original patterns must still fire (no regression):
  "I'm locked out",
  "my key doesn't work",
  "can't open the door",
  "the fob stopped working",
];

// MUST NOT fire — normal questions / neutral mentions of code/keypad/door.
const STAY_OUT = [
  "what's my door code?",
  "can I get the door code?",
  "how does the keypad work?",
  "is the code working today?",
  "what time is checkout?",
  "where is the front desk?",
];

ok('every active entry failure fires the lockout reply', () => {
  for (const m of FIRE) {
    assert.ok(firesLockout(m), `should FIRE lockout for: "${m}"`);
  }
});

ok('neutral code/keypad/door mentions do NOT fire the lockout reply', () => {
  for (const m of STAY_OUT) {
    assert.ok(!firesLockout(m), `should STAY OUT for: "${m}"`);
  }
});

console.log(`\n${pass} passed`);
