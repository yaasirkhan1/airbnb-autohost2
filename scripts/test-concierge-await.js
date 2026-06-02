// Fix 3 — await-before-promise. The guest is told "I've emailed the front desk"
// ONLY if the email actually succeeded.
//   success → exact "form emailed, tell the concierge to check their email" reply
//   failure → a DIFFERENT honest reply (does NOT claim it was emailed) + SMS escalate
// Only the concierge-hit case awaits; innocent messages take no concierge path.
//
// resolveConciergeReply injects sendEmail/escalate so both paths are unit-testable
// without booting the server or sending anything.
// Run: node scripts/test-concierge-await.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  resolveConciergeReply,
  conciergeGuestReply,
  conciergeFailureReply,
  conciergeHardcodedReply,
} = require('../src/concierge-email');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const CONCIERGE_REGEX = eval('new RegExp(' + src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/)[1] + '\n)');
const regexHit = t => CONCIERGE_REGEX.test(String(t).toLowerCase().replace(/[’‘]/g, "'"));

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };
const claimsEmailed = r => /emailed the front desk|form was sent|check their email/i.test(r);

(async () => {
  // SUCCESS path: email resolves → "emailed" reply, email awaited before reply, no escalation.
  await check('email SUCCESS → exact "emailed" reply, awaited, no escalation', async () => {
    const order = [];
    let escalated = false;
    const out = await resolveConciergeReply({
      guestName: 'Kedravious Webb',
      sendEmail: async () => { order.push('email'); },
      escalate: async () => { escalated = true; },
    });
    order.push('reply');
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.reply, conciergeGuestReply('Kedravious Webb'));
    assert.ok(claimsEmailed(out.reply), 'success reply should confirm the email');
    assert.strictEqual(escalated, false, 'must NOT escalate on success');
    assert.deepStrictEqual(order, ['email', 'reply'], 'email must be awaited before the reply');
  });

  // FAILURE path: email throws → different honest reply (no "emailed" claim) + escalate.
  await check('email FAILURE → honest reply (NOT "emailed") + SMS escalation', async () => {
    let escalateArg = null;
    const out = await resolveConciergeReply({
      guestName: 'Dekarius Pitts',
      sendEmail: async () => { throw new Error('Resend 500'); },
      escalate: async (e) => { escalateArg = e; },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reply, conciergeFailureReply('Dekarius Pitts'));
    assert.ok(!claimsEmailed(out.reply), `failure reply must NOT claim it was emailed:\n${out.reply}`);
    assert.ok(escalateArg instanceof Error, 'must SMS-escalate with the error on failure');
    assert.ok(/Resend 500/.test(escalateArg.message), 'escalation should carry the failure reason');
  });

  await check('resolveConciergeReply never throws even if escalate itself throws', async () => {
    const out = await resolveConciergeReply({
      guestName: 'X',
      sendEmail: async () => { throw new Error('boom'); },
      escalate: async () => { throw new Error('sms down'); },
    });
    assert.strictEqual(out.ok, false);
    assert.ok(!claimsEmailed(out.reply));
  });

  await check('conciergeFailureReply is honest: greets by name, no false "emailed" claim', () => {
    const r = conciergeFailureReply('Dekarius Pitts');
    assert.ok(r.startsWith('Hi Dekarius,'), 'greet by first name');
    assert.ok(!claimsEmailed(r), 'must not claim the email was sent');
    assert.ok(/notif|follow up|reach/i.test(r), 'should say we are being notified / will follow up');
  });

  // Innocent / non-concierge: takes NO concierge path at all (no email, no await).
  await check('innocent message → no concierge hit → no await/email path', () => {
    assert.strictEqual(regexHit('where is the front desk?'), false);
    assert.strictEqual(regexHit('what time is checkout?'), false);
    // conciergeHardcodedReply(false) → null means the normal Claude path runs.
    assert.strictEqual(conciergeHardcodedReply({ conciergeHit: false, guestName: 'X' }), null);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
