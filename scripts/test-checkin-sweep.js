'use strict';
// Tests for the morning check-in sweep + direct-question catch. Run: node scripts/test-checkin-sweep.js
// Uses DUMMY door codes; real codes live only in the gitignored volume store.
const assert = require('assert');
const sweep = require('../src/checkin-sweep');
const propsMap = require('../data/properties-map.json');

let pass = 0, fail = 0;
const checks = [];
const check = (n, f) => checks.push([n, f]);   // deferred so async tests are awaited below

const idByLabel = {};
for (const [id, e] of Object.entries(propsMap)) if (e.label) idByLabel[e.label] = id;

// DUMMY per-unit store (object shape).
const STORE = {
  '21-I': { code: '1005', wifi_name: '21-i' },
  '7-B':  { code: '1002', wifi_name: 'ARRIS-X', wifi_password: 'pw7b' },
  '24-L': { code: '1007' },
  // NOTE: 4-L intentionally has NO code → should be skipped.
};
const HOST = 'KS';
const resv = (unit, extra = {}) => ({ id: `res-${unit}`, listing_id: idByLabel[unit], guest: { first_name: 'Guest' + unit }, check_in: '2026-06-20', check_out: '2026-06-22', ...extra });
const SENT_THREAD = [{ sender_role: 'host', body: 'Access Instructions: When you arrive to the building, check in with front desk to register …' }];

check('CHECKIN_QUESTION_REGEX catches check-in questions; ignores unrelated', () => {
  for (const q of ["what's the checkin procedure?", 'how do I get in', 'check-in instructions please',
    'whats the door code', 'how do I check in', 'where do I go when I arrive', 'how to access the unit']) {
    assert.ok(sweep.CHECKIN_QUESTION_REGEX.test(q), `should match: ${q}`);
  }
  for (const q of ['can I check out late?', 'is there parking?', 'the wifi is slow']) {
    assert.ok(!sweep.CHECKIN_QUESTION_REGEX.test(q), `should NOT match: ${q}`);
  }
});

check('wasCheckinSent: host message with the distinctive line → true; guest copy / none → false', () => {
  assert.strictEqual(sweep.wasCheckinSent(SENT_THREAD), true);
  assert.strictEqual(sweep.wasCheckinSent([{ sender_role: 'guest', body: 'check in with front desk to register' }]), false);
  assert.strictEqual(sweep.wasCheckinSent([{ sender_role: 'host', body: 'your wifi password is x' }]), false);
  assert.strictEqual(sweep.wasCheckinSent([]), false);
});

check('SWEEP: same-day arrival w/ no prior instructions → SENT; one already sent → NOT re-sent', () => {
  const arrivals = [
    { reservation: resv('21-I'), thread: [] },           // fresh → send
    { reservation: resv('24-L'), thread: SENT_THREAD },  // already sent → skip (no double-send)
  ];
  const plan = sweep.decideSweep(arrivals, propsMap, STORE, HOST);
  assert.deepStrictEqual(plan.toSend.map(s => s.resId), ['res-21-I']);
  assert.deepStrictEqual(plan.alreadySent.map(s => s.resId), ['res-24-L']);
});

check('SWEEP: unit with a missing field is SKIPPED (not a broken send) for host alert', () => {
  const plan = sweep.decideSweep([{ reservation: resv('4-L'), thread: [] }], propsMap, STORE, HOST); // 4-L has no code
  assert.strictEqual(plan.toSend.length, 0);
  assert.strictEqual(plan.skipped.length, 1);
  assert.ok(plan.skipped[0].missing.includes('doorCode'), 'flags the missing door code');
});

check('NO CROSS-UNIT LEAK: each arrival message contains ONLY its own unit door code', () => {
  const arrivals = [{ reservation: resv('21-I'), thread: [] }, { reservation: resv('7-B'), thread: [] }];
  const plan = sweep.decideSweep(arrivals, propsMap, STORE, HOST);
  const byUnit = Object.fromEntries(plan.toSend.map(s => [s.unit, s.message]));
  assert.ok(byUnit['21-I'].includes('1005') && !byUnit['21-I'].includes('1002'), '21-I has only its own code');
  assert.ok(byUnit['7-B'].includes('1002') && !byUnit['7-B'].includes('1005'), '7-B has only its own code');
});

check('DIRECT-QUESTION catch: question + not-sent + fields present → send; already-sent → skip', () => {
  // not yet sent → planForReservation says send
  const p1 = sweep.planForReservation(resv('21-I'), [], propsMap, STORE, HOST);
  assert.strictEqual(p1.action, 'send');
  assert.ok(p1.message.includes('1005'));
  // already sent → no re-send even on a direct question
  const p2 = sweep.planForReservation(resv('21-I'), SENT_THREAD, propsMap, STORE, HOST);
  assert.strictEqual(p2.action, 'already_sent');
});

check('runSweep dryRun: computes the plan, sends NOTHING', async () => {
  let sends = 0, sms = 0;
  const res = await sweep.runSweep({
    today: '2026-06-20',
    listArrivals: async () => [resv('21-I'), resv('4-L')],
    fetchThread: async () => [],
    send: async () => { sends++; return {}; },
    smsHost: async () => { sms++; },
    propsMap, doorCodeStore: STORE, hostName: HOST, dryRun: true,
  });
  assert.strictEqual(sends, 0, 'no real sends in dry run');
  assert.strictEqual(sms, 0, 'no host SMS in dry run');
  assert.strictEqual(res.toSend.length, 1);   // 21-I
  assert.strictEqual(res.skipped.length, 1);  // 4-L missing code
  assert.ok(res.summary.includes('SKIPPED'));
});

(async () => {
  for (const [n, f] of checks) {
    try { await f(); console.log('✓', n); pass++; }
    catch (e) { console.log('✗', n, '\n   ', e.message); fail++; }
  }
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
