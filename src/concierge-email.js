// Pure builder for the front-desk / concierge authorization email.
// Kept side-effect-free so the body (including the confirmation code) is
// unit-testable without sending. server.js pulls the values off the real
// reservation and calls this.

function buildConciergeEmail({ guestName, unitLabel, checkIn, checkOut, code }) {
  const conf = code || 'N/A';
  const subject = `Check-In Info for Guest in ${unitLabel} | ${checkIn} - ${checkOut}`;
  const body = `Hi,

Please allow ${guestName} to access unit ${unitLabel}.

Guest Name: ${guestName}
Unit: ${unitLabel}
Confirmation Code: ${conf}
Check-In: ${checkIn} at 4:00 PM
Check-Out: ${checkOut}

Please grant this guest full access to the unit for the duration of their stay.

Thank you,
Yasser Khan
Peachtree Tower Rentals`;
  return { subject, body };
}

// The EXACT guest reply for a front-desk contingency — single source of truth so
// fragment-burst-detected requests get the same precise wording as single-message
// ones (never Claude's freeform version). server.js uses this both in
// detectHardcodedResponse and as the burst short-circuit in draftReply.
function conciergeGuestReply(guestName) {
  const name = (guestName || 'there').split(' ')[0];
  return `Hi ${name}, thanks for letting us know! A form was sent out this morning — I've also just emailed the front desk a supplementary email with your check-in information. Please let the front desk know that an email has been sent to them and to check their email — they should have everything they need to let you up right away. If you have any further trouble, reply here immediately and I'll call them directly. Welcome! 😊`;
}

// Routing helper: a detected front-desk contingency (by single regex, fragment
// burst, or classifier) → the exact hardcoded reply; otherwise null (→ Claude).
function conciergeHardcodedReply({ conciergeHit, guestName }) {
  if (!conciergeHit) return null;
  return { confident: true, reply: conciergeGuestReply(guestName) };
}

// Honest reply when the front-desk email did NOT go through. Must NOT claim the
// email was sent — instead tell the guest they're being notified and we'll follow up.
function conciergeFailureReply(guestName) {
  const name = (guestName || 'there').split(' ')[0];
  return `Hi ${name}, thanks for letting us know — I'm on it. I'm being notified right now and will follow up with the front desk directly to get you checked in. Please hang tight, and reply here if anything changes and I'll jump in immediately. 🙏`;
}

// Host SMS wording (trial: notify on every concierge event, not just failures).
function conciergeSentSms({ guestName, unitLabel }) {
  return `✅ Front-desk email SENT for ${guestName} / ${unitLabel} — guest told to check with the concierge.`;
}
function conciergeFailedSms({ guestName, unitLabel, error }) {
  const reason = error && error.message ? error.message.slice(0, 80) : 'unknown error';
  return `❌ Front-desk email FAILED for ${guestName} / ${unitLabel} (${reason}). Please call the front desk to authorize this guest's access.`;
}

// Await-before-promise orchestrator for a concierge hit: send the email FIRST, and
// only tell the guest "emailed" if it actually succeeded. On failure, return an
// honest reply (no false claim) and escalate to the host. Side-effects are injected
// so every path is unit-testable; never throws.
//   sendEmail()        — async, resolves on a real send, rejects on failure
//   notifySuccess(text)— async, SMS the host on success (only when notifyAll)
//   escalate(err)      — async, SMS the host on failure (always)
//   notifyAll          — trial gate (env CONCIERGE_NOTIFY_ALL !== 'false'); when
//                        false, success is silent (failure-only escalation)
async function resolveConciergeReply({ guestName, unitLabel, sendEmail, escalate, notifySuccess, notifyAll = true }) {
  try {
    await sendEmail();
    if (notifyAll && typeof notifySuccess === 'function') {
      try { await notifySuccess(conciergeSentSms({ guestName, unitLabel })); } catch (_) { /* best-effort */ }
    }
    return { ok: true, reply: conciergeGuestReply(guestName) };
  } catch (err) {
    if (typeof escalate === 'function') { try { await escalate(err); } catch (_) { /* best-effort */ } }
    return { ok: false, reply: conciergeFailureReply(guestName), error: err };
  }
}

module.exports = {
  buildConciergeEmail,
  conciergeGuestReply,
  conciergeFailureReply,
  conciergeHardcodedReply,
  resolveConciergeReply,
  conciergeSentSms,
  conciergeFailedSms,
};
