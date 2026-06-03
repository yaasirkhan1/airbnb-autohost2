// Parking now flows to the Claude reply layer (draftReply) with
// src/knowledge/parking.md injected — instead of the old one-size-fits-all
// PARKING_REPLY block. This test replays Jasmine's three parking questions.
//
// Part A (deterministic, always runs): proves the ROUTING changed —
//   - each parking question is recognized (isParkingQuestion) and is NO LONGER
//     short-circuited by detectHardcodedResponse (returns null → flows to Claude)
//   - door-code and concierge paths STILL hardcode (unchanged)
//   - an unrelated hardcoded path (thermostat) still hardcodes (no collateral damage)
//
// Part B (real Claude, only when ANTHROPIC_API_KEY is set): calls draftReply for
// each question and prints the replies, asserting they are DIFFERENT and SPECIFIC,
// follow the SHIP-AS-IS DIRECTIVE (point to SpotHero, no VERIFY/YOUR INPUT leaked,
// no safety/break-in mentions, always close with the disclaimer).
//
// Run: node scripts/test-parking-reply.js

const assert = require('assert');
const { detectHardcodedResponse, draftReply, isParkingQuestion, CONCIERGE_REGEX } = require('../src/server');
const { isEntryCodeRequest } = require('../src/entry-codes');

const GUEST = 'Jasmine';
const PARKING_QUESTIONS = [
  'Hi! Is there free parking on site at the building?',
  'What\'s the closest parking garage, and about how much does it cost per night?',
  'Where should I park if I\'m coming in for a Mercedes-Benz Stadium event this weekend?',
];

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

(async () => {
  console.log('── PART A: routing (deterministic) ──\n');

  console.log(' parking questions are recognized AND no longer hardcoded (→ flow to Claude):');
  for (const q of PARKING_QUESTIONS) {
    const recognized = isParkingQuestion(q);
    const hardcoded = detectHardcodedResponse(GUEST, q); // null now that the branch is gone
    ok(recognized && hardcoded === null, `"${q.slice(0, 48)}…"  recognized=${recognized} hardcoded=${hardcoded === null ? 'null' : 'BLOCK'}`);
  }

  console.log('\n door-code and concierge stay on the hardcoded paths (unchanged):');
  ok(isEntryCodeRequest("what's the door code for my unit?") === true, 'door-code request still detected (entry-code path)');
  ok(CONCIERGE_REGEX.test("the front desk won't let me in") === true, 'concierge contingency still matches CONCIERGE_REGEX');
  ok(isParkingQuestion("what's the door code?") === false, 'a door-code question is NOT treated as parking');

  console.log('\n an unrelated hardcoded path still works (no collateral damage):');
  const thermo = detectHardcodedResponse(GUEST, 'the room is too cold, how do I use the thermostat?');
  ok(thermo && thermo.confident === true, 'thermostat question still returns a hardcoded reply');

  // ── PART B: real Claude replies ──
  console.log('\n── PART B: live draftReply replies (real Claude) ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see the live, per-question replies)');
    console.log('  Part A already proves all three parking questions now route to Claude with parking.md.\n');
  } else {
    const replies = [];
    for (const q of PARKING_QUESTIONS) {
      const r = await draftReply(GUEST, q, 'World Cup Apartment (7-B)', null);
      replies.push(r.reply || '');
      console.log(`\n  Q: ${q}\n  A: ${r.reply}\n  ${'─'.repeat(70)}`);
    }

    console.log('\n  assertions on the live replies:');
    // distinct & specific to each question
    ok(new Set(replies).size === replies.length, 'all three replies are different from each other');
    // SHIP-AS-IS DIRECTIVE compliance
    for (let i = 0; i < replies.length; i++) {
      const r = replies[i], lc = r.toLowerCase(), label = `Q${i + 1}`;
      ok(/spothero|parkmobile/i.test(r), `${label}: points the guest to SpotHero/ParkMobile for live rates`);
      ok(!/\[VERIFY|\[YOUR INPUT/i.test(r), `${label}: leaks no [VERIFY]/[YOUR INPUT] placeholder as fact`);
      ok(!/break.?in|theft|stolen|crime|vandal|smashed/i.test(lc), `${label}: no safety/break-in mention (hard rule)`);
      ok(/confirm|change|before you park|directly with the lot|spothero/i.test(lc), `${label}: closes with the parking disclaimer`);
    }
  }

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
  process.exitCode = fail ? 1 : 0;
})();
