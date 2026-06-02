// Trial feature — host SMS on EVERY front-desk concierge event, not just failures.
//   success → "✅ Front-desk email SENT for {guest} / {unit} — guest told to check
//             with concierge"   (gated by CONCIERGE_NOTIFY_ALL, default ON)
//   failure → "❌ ... FAILED ..." escalation (always)
// Flip off later with CONCIERGE_NOTIFY_ALL=false (passed in as notifyAll).
// Run: node scripts/test-concierge-notify.js
const assert = require('assert');
const {
  resolveConciergeReply,
  conciergeGuestReply,
  conciergeFailureReply,
  conciergeSentSms,
  conciergeFailedSms,
} = require('../src/concierge-email');

let pass = 0, fail = 0;
const check = async (n, f) => { try { await f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// ── SMS wording builders ────────────────────────────────────────────────────
check('conciergeSentSms: ✅ SENT wording with guest + unit + "check with concierge"', () => {
  const s = conciergeSentSms({ guestName: 'Dekarius Pitts', unitLabel: '24-L' });
  assert.ok(s.includes('✅'), 'missing ✅');
  assert.ok(/sent/i.test(s), 'missing SENT');
  assert.ok(s.includes('Dekarius Pitts') && s.includes('24-L'), 'missing guest/unit');
  assert.ok(/check (with )?(the )?concierge/i.test(s), 'missing "check with concierge"');
});

check('conciergeFailedSms: ❌ FAILED wording with guest + unit + reason', () => {
  const s = conciergeFailedSms({ guestName: 'Kedravious Webb', unitLabel: '4-L', error: new Error('Resend 500') });
  assert.ok(s.includes('❌'), 'missing ❌');
  assert.ok(/fail/i.test(s), 'missing FAILED');
  assert.ok(s.includes('Kedravious Webb') && s.includes('4-L'), 'missing guest/unit');
  assert.ok(s.includes('Resend 500'), 'missing failure reason');
});

// ── SUCCESS → SENT SMS (gated) ──────────────────────────────────────────────
(async () => {
  await check('success + notifyAll=true → notifySuccess gets exact SENT text; no escalate', async () => {
    let sentArg = null, escalated = false;
    const out = await resolveConciergeReply({
      guestName: 'Dekarius Pitts', unitLabel: '24-L', notifyAll: true,
      sendEmail: async () => {},
      notifySuccess: async (text) => { sentArg = text; },
      escalate: async () => { escalated = true; },
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(out.reply, conciergeGuestReply('Dekarius Pitts'));
    assert.strictEqual(sentArg, conciergeSentSms({ guestName: 'Dekarius Pitts', unitLabel: '24-L' }));
    assert.strictEqual(escalated, false);
  });

  await check('success + notifyAll=false → notifySuccess NOT called (failure-only mode)', async () => {
    let called = false;
    const out = await resolveConciergeReply({
      guestName: 'X', unitLabel: '7-B', notifyAll: false,
      sendEmail: async () => {},
      notifySuccess: async () => { called = true; },
      escalate: async () => {},
    });
    assert.strictEqual(out.ok, true);
    assert.strictEqual(called, false, 'must not SMS on success when notifyAll is off');
  });

  // ── FAILURE → FAILED escalation (always, regardless of notifyAll) ──────────
  await check('failure → escalate(err) called, notifySuccess NOT called, honest reply', async () => {
    let escErr = null, successCalled = false;
    const out = await resolveConciergeReply({
      guestName: 'Dekarius Pitts', unitLabel: '24-L', notifyAll: true,
      sendEmail: async () => { throw new Error('Resend 500'); },
      notifySuccess: async () => { successCalled = true; },
      escalate: async (e) => { escErr = e; },
    });
    assert.strictEqual(out.ok, false);
    assert.strictEqual(out.reply, conciergeFailureReply('Dekarius Pitts'));
    assert.ok(escErr instanceof Error && /Resend 500/.test(escErr.message), 'must escalate with error');
    assert.strictEqual(successCalled, false, 'no SENT SMS on failure');
  });

  await check('success + notifySuccess throws → still ok, never throws', async () => {
    const out = await resolveConciergeReply({
      guestName: 'X', unitLabel: '7-B', notifyAll: true,
      sendEmail: async () => {},
      notifySuccess: async () => { throw new Error('sms down'); },
      escalate: async () => {},
    });
    assert.strictEqual(out.ok, true);
  });

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0;
})();
