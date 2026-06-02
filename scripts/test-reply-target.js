// Reply-target routing for webhook messages. Order:
//   reservation_id → inquiry_id → conversation_id (reservation match FIRST, then inquiry match)
// Zee's case: reservation_id & inquiry_id null, but conversation_id IS the inquiry id →
// reply via POST /inquiries/{conversation_id}/messages. Recoverable case: conversation_id
// matches a reservation's conversation_id → reply via that reservation. None resolve → null
// (the caller escalates by SMS instead of dropping).
// Run: node scripts/test-reply-target.js
const assert = require('assert');
const { resolveReplyTarget } = require('../src/reply-target');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

const CONV = '7b9fe8d8-b0b4-4aa3-ae28-5b7d0c896bdb'; // Zee's conversation_id (== inquiry id)
const RES_CONV = '82382083-675b-4685-8eb0-fa5e46d12703';
const reservations = [
  { id: 'res-aaa', conversation_id: '93409fef-7a8b-414e-8a78-53b917054dcc' },
  { id: 'res-bbb', conversation_id: RES_CONV }, // reservation-backed thread
];
const inquiryIds = [CONV, '592746d5-1aae-4a6a-b1d7-1527cdd7d337'];

check('reservation_id present → reservation (wins over everything)', () => {
  const t = resolveReplyTarget({ reservationId: 'R1', inquiryId: 'I1', conversationId: CONV, reservations, inquiryIds });
  assert.deepStrictEqual(t, { resourceId: 'R1', resourceType: 'reservation', via: 'reservation_id' });
});

check('inquiry_id present (no reservation_id) → inquiry', () => {
  const t = resolveReplyTarget({ reservationId: null, inquiryId: 'I1', conversationId: CONV, reservations, inquiryIds });
  assert.deepStrictEqual(t, { resourceId: 'I1', resourceType: 'inquiry', via: 'inquiry_id' });
});

check('both null + conversation matches a RESERVATION conv → reservation (resolution feature)', () => {
  const t = resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: RES_CONV, reservations, inquiryIds });
  assert.deepStrictEqual(t, { resourceId: 'res-bbb', resourceType: 'reservation', via: 'conversation_id->reservation' });
});

check("both null + conversation is an INQUIRY id (Zee's case) → inquiry via conversation_id", () => {
  const t = resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: CONV, reservations, inquiryIds });
  assert.deepStrictEqual(t, { resourceId: CONV, resourceType: 'inquiry', via: 'conversation_id->inquiry' });
});

check('reservation match takes precedence over inquiry match for the same conversation_id', () => {
  const t = resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: RES_CONV,
    reservations, inquiryIds: [RES_CONV, ...inquiryIds] }); // conv appears in BOTH
  assert.strictEqual(t.resourceType, 'reservation', 'reservation must win');
  assert.strictEqual(t.resourceId, 'res-bbb');
});

check('conversation matches NEITHER reservation nor inquiry → null (caller escalates)', () => {
  const t = resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: 'unknown-conv', reservations, inquiryIds });
  assert.strictEqual(t, null);
});

check('VERIFY-before-send: an unverified conversation_id is NOT blindly routed to inquiry', () => {
  // conversation_id present but inquiryIds empty + no reservation match → must NOT assume inquiry
  const t = resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: CONV, reservations, inquiryIds: [] });
  assert.strictEqual(t, null, 'without confirming it is an inquiry id, do not POST to /inquiries');
});

check('nothing present → null', () => {
  assert.strictEqual(resolveReplyTarget({ reservationId: null, inquiryId: null, conversationId: null }), null);
  assert.strictEqual(resolveReplyTarget({}), null);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
