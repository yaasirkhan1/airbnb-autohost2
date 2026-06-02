// Resolve where to POST a webhook reply. Hospitable sometimes delivers a guest
// message with reservation_id AND inquiry_id null, carrying only a conversation_id
// (+ property). Two recoveries (verified against the live API):
//   - the conversation_id may equal a backing reservation's conversation_id  → reply via that reservation
//   - for a pre-booking inquiry, the conversation_id IS the inquiry id        → POST /inquiries/{conversation_id}/messages
//
// Order: reservation_id → inquiry_id → conversation_id (reservation match FIRST, then inquiry match).
// VERIFY before send: the inquiry route fires ONLY when conversation_id is confirmed
// present in the property's inquiry ids — never a blind POST to a non-inquiry.
// Returns null when nothing resolves; the caller escalates (does not silently drop).
//
// Pure / no side effects — the caller fetches `reservations` and `inquiryIds`.
function resolveReplyTarget({ reservationId, inquiryId, conversationId, reservations = [], inquiryIds = [] } = {}) {
  if (reservationId) return { resourceId: reservationId, resourceType: 'reservation', via: 'reservation_id' };
  if (inquiryId)     return { resourceId: inquiryId,     resourceType: 'inquiry',     via: 'inquiry_id' };

  if (conversationId) {
    const r = (reservations || []).find(x => x && x.conversation_id === conversationId);
    if (r && r.id) return { resourceId: r.id, resourceType: 'reservation', via: 'conversation_id->reservation' };

    if ((inquiryIds || []).includes(conversationId)) {
      return { resourceId: conversationId, resourceType: 'inquiry', via: 'conversation_id->inquiry' };
    }
  }
  return null;
}

module.exports = { resolveReplyTarget };
