// Tests for the concierge follow-up actions (no detection logic touched):
//   (1) concierge SMS fires to CONCIERGE_PHONE on email success (both paths route through
//       resolveConciergeReply via runConciergeContingency), NOT on failure;
//   (2) the front-desk email carries the "office of Mr. Yaasir Khan" legitimacy identifier;
//   (3) the guest reply returned on success is the front-desk confirmation (what the AI
//       path now schedules, same as the regex path).
// Run: node scripts/test-concierge-followups.js
'use strict';
const assert = require('assert');
const {
  buildConciergeEmail, conciergeSms, conciergeGuestReply, conciergeFailureReply, resolveConciergeReply,
} = require('../src/concierge-email');

let pass = 0;
const ok = async (n, f) => { await f(); console.log('✓', n); pass++; };

(async () => {
  // ── (2) EMAIL LEGITIMACY ──
  await ok('email states it is an automated message from the office of Mr. Yaasir Khan', () => {
    const { subject, body } = buildConciergeEmail({ guestName: 'Eshia Brown', unitLabel: '7-B', checkIn: '2026-06-05', checkOut: '2026-06-07', code: 'ABC123' });
    assert.ok(/office of Mr\.?\s*Yaasir Khan/i.test(body), 'body must carry the office-of-Mr.-Yaasir-Khan identifier');
    assert.ok(/not spam/i.test(body), 'body should explicitly disclaim spam (front desk thought it was a scam)');
    assert.ok(/Yaasir Khan/i.test(subject), 'subject should also identify the office');
    for (const frag of ['Eshia Brown', '7-B', 'ABC123', '2026-06-05', '2026-06-07']) {
      assert.ok(body.includes(frag), `details intact: "${frag}" present`);
    }
  });

  // ── (1) CONCIERGE SMS CONTENT ──
  await ok('conciergeSms carries identifier, guest, unit, concierge email, and mention-request', () => {
    const sms = conciergeSms({ guestName: 'Eshia Brown', unitLabel: '7-B', conciergeEmail: '300ptconcierge@gmail.com' });
    assert.ok(/office of Mr\.?\s*Yaasir Khan/i.test(sms));
    assert.ok(/Mr\.?\s*Khan is currently unavailable/i.test(sms));
    assert.ok(sms.includes('Eshia Brown') && sms.includes('7-B'));
    assert.ok(sms.includes('300ptconcierge@gmail.com'), 'names the concierge inbox to check');
    assert.ok(/asked to mention this email/i.test(sms));
  });

  // ── (1) SMS FIRES ON SUCCESS, NOT ON FAILURE (the firing both paths share) ──
  await ok('concierge SMS fires once on email SUCCESS (both paths route through here)', async () => {
    let conciergeCalls = 0, hostCalls = 0;
    const res = await resolveConciergeReply({
      guestName: 'Eshia Brown', unitLabel: '7-B',
      sendEmail: async () => {},
      notifyConcierge: async () => { conciergeCalls++; },
      notifySuccess: async () => { hostCalls++; },
      escalate: async () => { throw new Error('escalate should not run on success'); },
    });
    assert.strictEqual(conciergeCalls, 1, 'concierge SMS must fire exactly once on success');
    assert.strictEqual(hostCalls, 1, 'host SMS still fires on success');
    assert.strictEqual(res.ok, true);
  });

  await ok('concierge SMS does NOT fire on email FAILURE; escalate does', async () => {
    let conciergeCalls = 0, escalateCalls = 0;
    const res = await resolveConciergeReply({
      guestName: 'Eshia Brown', unitLabel: '7-B',
      sendEmail: async () => { throw new Error('email send failed'); },
      notifyConcierge: async () => { conciergeCalls++; },
      escalate: async () => { escalateCalls++; },
    });
    assert.strictEqual(conciergeCalls, 0, 'no concierge SMS when the email never sent');
    assert.strictEqual(escalateCalls, 1, 'host escalation fires on failure');
    assert.strictEqual(res.ok, false);
  });

  await ok('a thrown concierge SMS never breaks the flow (still returns success + guest reply)', async () => {
    const res = await resolveConciergeReply({
      guestName: 'Eshia Brown', unitLabel: '7-B',
      sendEmail: async () => {},
      notifyConcierge: async () => { throw new Error('OpenPhone 402'); },
      notifySuccess: async () => {},
      escalate: async () => {},
    });
    assert.strictEqual(res.ok, true, 'email succeeded → success even if concierge SMS throws');
    assert.strictEqual(res.reply, conciergeGuestReply('Eshia Brown'));
  });

  // ── (3) AI PATH GUEST CONFIRMATION ──
  // Both regex and AI paths now schedule resolveConciergeReply's `reply`. Confirm it IS the
  // front-desk confirmation on success and the honest follow-up on failure.
  await ok('guest reply on success is the front-desk confirmation (what the AI path now schedules)', async () => {
    const okRes = await resolveConciergeReply({ guestName: 'Eshia Brown', unitLabel: '7-B', sendEmail: async () => {}, notifyConcierge: async () => {}, notifySuccess: async () => {} });
    assert.strictEqual(okRes.reply, conciergeGuestReply('Eshia Brown'));
    assert.ok(/emailed the front desk/i.test(okRes.reply), 'guest is told the front desk was emailed');
    const failRes = await resolveConciergeReply({ guestName: 'Eshia Brown', unitLabel: '7-B', sendEmail: async () => { throw new Error('x'); }, notifyConcierge: async () => {}, escalate: async () => {} });
    assert.strictEqual(failRes.reply, conciergeFailureReply('Eshia Brown'));
  });

  // ── (1) sendOpenPhoneSms targets the given recipient (CONCIERGE_PHONE) ──
  await ok('sendOpenPhoneSms POSTs to the exact recipient (CONCIERGE_PHONE) with the body', async () => {
    const origFetch = global.fetch;
    const saved = { k: process.env.QUO_API_KEY, f: process.env.QUO_FROM_NUMBER, p: process.env.CONCIERGE_PHONE };
    process.env.QUO_API_KEY = 'test-key'; process.env.QUO_FROM_NUMBER = '+16785396633'; process.env.CONCIERGE_PHONE = '+14045551234';
    let captured = null;
    global.fetch = async (url, opts) => { captured = { url, body: JSON.parse(opts.body), auth: opts.headers.Authorization }; return { ok: true, text: async () => 'ok' }; };
    try {
      const { sendOpenPhoneSms } = require('../src/server');
      const r = await sendOpenPhoneSms(process.env.CONCIERGE_PHONE, conciergeSms({ guestName: 'Eshia Brown', unitLabel: '7-B', conciergeEmail: '300ptconcierge@gmail.com' }));
      assert.strictEqual(r.ok, true);
      assert.strictEqual(captured.url, 'https://api.openphone.com/v1/messages');
      assert.deepStrictEqual(captured.body.to, ['+14045551234'], 'must send to CONCIERGE_PHONE');
      assert.strictEqual(captured.auth, 'test-key');
      assert.ok(/office of Mr\.?\s*Yaasir Khan/i.test(captured.body.content), 'concierge SMS body sent');
    } finally {
      global.fetch = origFetch;
      process.env.QUO_API_KEY = saved.k; process.env.QUO_FROM_NUMBER = saved.f; process.env.CONCIERGE_PHONE = saved.p;
    }
  });

  console.log(`\n${pass}/7 passed`);
})().catch(e => { console.error('❌ FAILED:', e.message); process.exit(1); });
