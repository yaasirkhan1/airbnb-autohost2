// Convention/venue proximity answers flow to draftReply with src/knowledge/conventions.md injected
// ONLY on convention questions (topic-gated, like parking/restaurants).
//
// Part A (deterministic): proves the GATE — convention/venue/hotel questions are recognized
// (isConventionQuestion) and not hardcoded; unrelated messages are NOT treated as convention.
//
// Part B (real Claude, only with ANTHROPIC_API_KEY): asserts the replies LEAD with proximity,
// stay confident/non-empty, and don't invent event schedules.
//
// Run: node scripts/test-convention-reply.js
'use strict';
const assert = require('assert');
const { detectHardcodedResponse, draftReply } = require('../src/server');
const { isConventionQuestion } = require('../src/convention-knowledge');

const GUEST = 'Dana';
const CONVENTION_QUESTIONS = [
  'My conference is at the Hyatt Regency — how close is your place?',
  "I'm in town for a trade show at AmericasMart, is it walkable?",
  'How far is the Georgia World Congress Center from the apartment?',
  'Staying for a convention near the Marriott Marquis — where are you relative to it?',
];
const NOT_CONVENTION = [
  "what's the door code for my unit?",
  'where should I park for the game?',
  'can you recommend a good steakhouse?',
  'what time is check-in?',
];

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

(async () => {
  console.log('── PART A: gating (deterministic) ──\n');
  console.log(' convention questions are recognized AND not hardcoded (→ flow to Claude w/ conventions.md):');
  for (const q of CONVENTION_QUESTIONS) {
    const recognized = isConventionQuestion(q);
    const hardcoded = detectHardcodedResponse(GUEST, q);
    ok(recognized && hardcoded === null, `"${q.slice(0, 50)}…"  recognized=${recognized} hardcoded=${hardcoded === null ? 'null' : 'BLOCK'}`);
  }

  console.log('\n unrelated messages are NOT treated as convention questions (gate is clean):');
  for (const q of NOT_CONVENTION) ok(isConventionQuestion(q) === false, `not convention: "${q}"`);

  console.log('\n unrelated hardcoded path still works (no collateral damage):');
  const thermo = detectHardcodedResponse(GUEST, 'the room is too cold, how do I use the thermostat?');
  ok(thermo && thermo.confident === true, 'thermostat question still returns a hardcoded reply');

  console.log('\n── PART B: live draftReply replies (real Claude) ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see the live, per-question replies)');
    console.log('  Part A already proves convention questions route to Claude with conventions.md.\n');
  } else {
    // Inquiry (SALES mode) → should sell proximity hard and name the venue/hotel placement.
    const checks = [
      ['My conference is at the Hyatt Regency — how close is your place?', /across the street|directly across|right across|steps|next to|0\.0?3|on top of it/i, 'Hyatt = across the street'],
      ["I'm in town for a trade show at AmericasMart, is it walkable?",     /walk|minutes?|0\.1|close|short/i, 'AmericasMart = short walk'],
      ['How far is the Georgia World Congress Center from the apartment?',  /walk|0\.6|easy|mile|short ride/i, 'GWCC = easy walk'],
    ];
    for (const [q, proximityRe, label] of checks) {
      const r = await draftReply(GUEST, q, 'Apt 4-L', null, false, null, null); // null resourceType → SALES
      const reply = (r && r.reply) || '';
      console.log(`\n  Q: ${q}\n  A: ${reply}\n  ${'─'.repeat(70)}`);
      ok(reply.trim().length > 0 && r.confident === true, `${label}: helpful, confident reply`);
      ok(proximityRe.test(reply), `${label}: leads with proximity`);
      ok(!/schedule|agenda|session times|room rate|\$\d/i.test(reply), `${label}: no invented event schedule / hotel rate`);
    }

    // STRICT GROUNDING: an out-of-KB hotel ("Signia by Hilton" is NOT listed) → closest in-house
    // match from the KB (a listed anchor / the district), never a fabricated distance for the unlisted name.
    const oq = 'My convention block is at the Signia by Hilton — how close is your place?';
    const or_ = await draftReply(GUEST, oq, 'Apt 4-L', null, false, null, null);
    const oreply = (or_ && or_.reply) || '';
    console.log(`\n  Q (out-of-KB): ${oq}\n  A: ${oreply}\n  ${'─'.repeat(70)}`);
    ok(oreply.trim().length > 0 && or_.confident === true, 'out-of-KB: still a helpful, confident reply');
    ok(/hyatt|marriott|marquis|westin|hilton|gwcc|world congress|americasmart|peachtree center|convention district/i.test(oreply),
      'out-of-KB: gives the closest in-house anchor from the KB');
    ok(!/signia[^.]{0,40}~?\s*0?\.\d+\s*mi/i.test(oreply), 'out-of-KB: does NOT fabricate a distance for the unlisted hotel');
  }

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
  process.exitCode = fail ? 1 : 0;
})();
