// Regression for the Ashley/7-B bug (2026-06-13): a refund COMPLAINT wrongly fired the canned
// concierge/front-desk access reply because (a) CONCIERGE_REGEX hit a too-broad zero-width
// lookahead, and (b) the isMoneyComplaint guardrail ran AFTER the concierge fire and was
// short-circuited. The fix: tighten that lookahead, run isMoneyComplaint FIRST, and add an LLM
// context gate (ACCESS vs COMPLAINT) before the canned reply.
//
// Part A (deterministic): regex + money guardrail.
//   - Ashley's actual complaint must NOT match CONCIERGE_REGEX, and MUST match isMoneyComplaint.
//   - genuine access cases (form not sent, front desk has no record) must STILL match the regex.
//   - a money/refund complaint must match isMoneyComplaint.
//
// Part B (real Claude, only with ANTHROPIC_API_KEY): the LLM intent gate (classifyAccessIntent),
//   each case SAMPLED N times for reliability:
//   - Ashley's complaint → 'complaint'
//   - genuine access messages → 'access'
//   - a dirty-unit refund complaint → 'complaint'
//
// Run: node scripts/test-concierge-complaint-gate.js
'use strict';
const assert = require('assert');
const { CONCIERGE_REGEX, isMoneyComplaint } = require('../src/server');
const { classifyAccessIntent } = require('../src/concierge-classifier');

// ── Ashley's actual message, pasted from the Railway logs (res 5209f700, unit 7-B) ──
const ASHLEY_COMPLAINT = "Barron,\nI appreciate your response, but I think we’re looking at this from different perspectives. My concern isn’t whether you personally believe this unit is better than the one I originally booked. The issue is that I did not receive the unit I selected and paid for based on the listing, photos, location within the building, and overall presentation.\n\nIn addition, the situation has involve several inconveniences that were outside of my control: \n\nI had to repeatedly follow up regarding additional night because the reservation was not updated through VRBO. I was asked to pay for the additional night through PayPal because of booking issues which is frowned upon through VRBO. \nUpon arrival, I was informed that our reservation had been mistakenly double booked and I would need to stay in a different unit. The first replacement unit was not properly clean and had several maintenance issues, including what towels, dirty floors, a damaged vanity, and sheets that had hair on them.\nThe following day, I was asked to interrupt my schedule, return to the property, impact my belongings and move again. The second unit is not the unit represented in the listing that I booked, and it has its own cleanliness and maintenance concerns, including dirty walls and doors, a non-functioning, kitchen, light, worn and stained furniture, rusted bathroom fixtures, missing, lightbulbs, in adequate cooling, and leftover personal items from previous occupants. \n\nWhether you consider this unit and upgrade is ultimately subjective. What is not subjective is that I did not receive the accommodation that I booked, experienced multiple disruptions because of booking errors, and encountered clients and maintenance issues in both replacement units.\n\nI’ve tried to be pretty easy-going about all of this, but everything just keeps piling up. I spoken to other people from the American Mart that I run into that are staying at the same place and they have said that their unit is wonderful. Upon investigation of other units have found that they are well updated and maintained unlike these.\n\nGiven these circumstances, I believe a partial refund or a discount of some kind as a reasonable request and would be inappropriate way to address the inconvenience and the difference between what was advertised and what was ultimately provided .\n\nI would appreciate your reconsideration. Thank you.\n\n";

// Genuine ACTIVE access problems — must keep firing.
const ACCESS_CASES = [
  'The front desk has no record of my reservation and won’t let me up.',
  'I’m still waiting in the lobby, they can’t find my booking and won’t let me in.',
  'The check-in form was never sent so the front desk can’t check me in.',
];
// Money/refund complaint that must be caught by isMoneyComplaint (not concierge).
const MONEY_COMPLAINT = 'The unit was filthy and not what I booked. I want a partial refund for this.';

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

(async () => {
  console.log('── PART A: regex + money guardrail (deterministic) ──\n');

  console.log(' Ashley\'s refund complaint:');
  ok(CONCIERGE_REGEX.test(ASHLEY_COMPLAINT) === false, 'does NOT match CONCIERGE_REGEX (tightened lookahead — no longer false-fires)');
  ok(isMoneyComplaint(ASHLEY_COMPLAINT) === true, 'DOES match isMoneyComplaint → escalates silently, runs before concierge');

  console.log('\n genuine ACTIVE access cases still match CONCIERGE_REGEX:');
  for (const q of ACCESS_CASES) ok(CONCIERGE_REGEX.test(q) === true, `matches: "${q.slice(0, 56)}…"`);

  console.log('\n money/refund complaint hits the money guardrail:');
  ok(isMoneyComplaint(MONEY_COMPLAINT) === true, 'isMoneyComplaint(dirty-unit refund) === true');

  // ── PART B: LLM intent gate, sampled N times each ──
  console.log('\n── PART B: LLM context gate (classifyAccessIntent), sampled ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to sample the live intent gate)');
    console.log(`\nRESULT: ${fail === 0 ? 'PART A ALL PASS' : fail + ' FAILED'}`);
    process.exitCode = fail ? 1 : 0;
    return;
  }

  const { callClaude } = require('../src/server');
  const N = 5;
  const sample = async (text, expect, label) => {
    const got = [];
    for (let i = 0; i < N; i++) {
      const rec = await classifyAccessIntent({ text, callClaude, env: process.env, timeoutMs: 5000 });
      got.push(rec.intent);
    }
    const hits = got.filter(g => g === expect).length;
    ok(hits === N, `${label}: ${hits}/${N} → ${expect}  [${got.join(',')}]`);
  };

  await sample(ASHLEY_COMPLAINT, 'complaint', "Ashley's complaint");
  for (const q of ACCESS_CASES) await sample(q, 'access', `access: "${q.slice(0, 44)}…"`);
  await sample(MONEY_COMPLAINT, 'complaint', 'dirty-unit refund complaint');

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
  process.exitCode = fail ? 1 : 0;
})();
