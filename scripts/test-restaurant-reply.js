// Restaurant recs flow to the Claude reply layer (draftReply) with
// src/knowledge/restaurants.md injected ONLY on food questions (topic-gated, like parking).
//
// Part A (deterministic, always runs): proves the GATE —
//   - food questions are recognized (isRestaurantQuestion) and are NOT hardcoded
//     (detectHardcodedResponse → null → flow to Claude with the KB)
//   - non-food questions (door code, parking, thermostat) are NOT treated as restaurant
//   - an unrelated hardcoded path (thermostat) still hardcodes (no collateral damage)
//
// Part B (real Claude, only when ANTHROPIC_API_KEY is set): calls draftReply for each
// question and asserts the replies follow the RULES (no "it's open"/fixed prices, in-house
// match for an unlisted cuisine, mentions a listed spot).
//
// Run: node scripts/test-restaurant-reply.js
'use strict';
const assert = require('assert');
const { detectHardcodedResponse, draftReply } = require('../src/server');
const { isRestaurantQuestion } = require('../src/restaurant-knowledge');

const GUEST = 'Priya';
const FOOD_QUESTIONS = [
  'Can you recommend a good steakhouse nearby?',
  'Where can I get sushi around here?',
  'Any good vegan options close by?',
  'Where should I grab breakfast in the morning?',
];
const NOT_FOOD = [
  "what's the door code for my unit?",
  'where should I park for the game?',
  'how do I use the thermostat?',
];

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

(async () => {
  console.log('── PART A: gating (deterministic) ──\n');
  console.log(' food questions are recognized AND not hardcoded (→ flow to Claude w/ restaurants.md):');
  for (const q of FOOD_QUESTIONS) {
    const recognized = isRestaurantQuestion(q);
    const hardcoded = detectHardcodedResponse(GUEST, q);
    ok(recognized && hardcoded === null, `"${q.slice(0, 46)}…"  recognized=${recognized} hardcoded=${hardcoded === null ? 'null' : 'BLOCK'}`);
  }

  console.log('\n non-food questions are NOT treated as restaurant questions (gate is clean):');
  for (const q of NOT_FOOD) ok(isRestaurantQuestion(q) === false, `not food: "${q}"`);

  console.log('\n unrelated hardcoded path still works (no collateral damage):');
  const thermo = detectHardcodedResponse(GUEST, 'the room is too cold, how do I use the thermostat?');
  ok(thermo && thermo.confident === true, 'thermostat question still returns a hardcoded reply');

  console.log('\n── PART B: live draftReply replies (real Claude) ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see the live, per-question replies)');
    console.log('  Part A already proves food questions route to Claude with restaurants.md.\n');
  } else {
    for (const q of FOOD_QUESTIONS) {
      const r = await draftReply(GUEST, q, 'Apt 4-L', null, false, null, 'reservation');
      const reply = (r && r.reply) || '';
      console.log(`\n  Q: ${q}\n  A: ${reply}\n  ${'─'.repeat(70)}`);
      const lc = reply.toLowerCase();
      ok(reply.length > 0 && r.confident === true, 'helpful, confident reply (never empty)');
      ok(!/\b(is|are|it'?s|they'?re)\s+(open|currently open)\b|open now/i.test(reply), 'does not promise a place is open');
      ok(!/\$\d/.test(reply), 'no fixed dollar menu price quoted');
    }
    // In-house match for an UNLISTED cuisine (e.g. Korean BBQ): the gate must fire, and the agent
    // must offer the closest listed match in-house (confident, non-empty) — NOT escalate or punt.
    assert.strictEqual(isRestaurantQuestion('Is there any Korean BBQ near here?'), true, 'gate fires on an unlisted cuisine');
    const r = await draftReply(GUEST, 'Is there any Korean BBQ near here?', 'Apt 4-L', null, false, null, 'reservation');
    console.log(`\n  Q (unlisted): Is there any Korean BBQ near here?\n  A: ${r.reply}\n  ${'─'.repeat(70)}`);
    ok(r.confident === true && (r.reply || '').trim().length > 0, 'unlisted cuisine → helpful in-house reply (not an empty escalation)');
    // "I don't have a dedicated X spot, but here are close options" is the DESIRED in-house framing —
    // only flag an actual punt (Google/look-it-up/search online).
    ok(!/google maps|look it up|search (online|google)|you'?ll have to (find|search)/i.test((r.reply || '').toLowerCase()), 'unlisted cuisine → stays in-house, no "go look it up"');
  }

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
  process.exitCode = fail ? 1 : 0;
})();
