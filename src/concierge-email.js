// Pure builder for the front-desk / concierge authorization email.
// Kept side-effect-free so the body (including the confirmation code) is
// unit-testable without sending. server.js pulls the values off the real
// reservation and calls this.

// Authorizer is FIXED — always Yasser Khan, regardless of any value passed in.
const CONCIERGE_AUTHORIZER = 'Yasser Khan';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// "2026-06-20T16:00:00-04:00" or "2026-06-20" -> "Saturday, June 20, 2026". Works off the
// date PART of the string (the reservation's own local date), so no timezone rollover. Noon-UTC
// anchor gives the correct weekday without DST/offset drift. Unparseable input passes through.
function fmtDate(value) {
  if (!value || value === 'N/A') return 'N/A';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value));
  if (!m) return String(value);
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  return `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}
// "2026-06-20T16:00:00-04:00" -> "4:00 PM" (the wall-clock time in the timestamp's own offset).
// Date-only or timeless input -> null (caller falls back to the standard 4:00 PM check-in).
function fmtTime(value) {
  const m = /T(\d{2}):(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  let h = +m[1]; const min = m[2]; const ap = h < 12 ? 'AM' : 'PM';
  h = h % 12 || 12;
  return `${h}:${min} ${ap}`;
}
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function buildConciergeEmail({ guestName, unitLabel, checkIn, checkOut, arrivalTime, numGuests, code }) {
  const arrival = fmtTime(checkIn) || arrivalTime || '4:00 PM';            // from timestamp, else default
  const guests  = (numGuests != null && numGuests !== '') ? String(numGuests) : 'N/A';
  const conf    = code || 'N/A';
  const dates   = `${fmtDate(checkIn)} – ${fmtDate(checkOut)}`;
  const subject = `Check-In Authorization — ${unitLabel} | ${dates}`;

  const note = `Hello, this is ${CONCIERGE_AUTHORIZER}. I am formally requesting that the following guest be granted access to the building for their stay. This is a legitimate, authorized check-in request — not spam or a phishing attempt. Their check-in details are below.`;
  const fields = [
    ['Name of guest', guestName],
    ['Arrival & Departure Dates', dates],
    ['Unit Number', unitLabel],
    ['Confirmation Code', conf],
    ['Arrival Time', arrival],
    ['Number of guests', guests],
    ['The person authorizing the stay', CONCIERGE_AUTHORIZER],
  ];
  const closing = `Thank you,\n${CONCIERGE_AUTHORIZER}\nPeachtree Tower Rentals`;

  // Plain-text part: note paragraph, blank line, one field per line, blank line, closing.
  const body = `${note}\n\n${fields.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${closing}`;
  // HTML part: <br>/<p> so the line breaks survive in real mail clients (which collapse \n).
  const html = `<p>${esc(note)}</p>\n<p>${fields.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('<br>\n')}</p>\n<p>${esc('Thank you,')}<br>\n${esc(CONCIERGE_AUTHORIZER)}<br>\n${esc('Peachtree Tower Rentals')}</p>`;
  return { subject, body, html };
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

// Front-desk/concierge SMS — sent to CONCIERGE_PHONE after the email succeeds, giving the
// desk a heads-up to check their inbox. Mirrors the email's "office of Mr. Yasser Khan"
// legitimacy framing (the desk previously suspected the email was a scam).
function conciergeSms({ guestName, unitLabel, conciergeEmail }) {
  return `This is an automated message from the office of Mr. Yasser Khan. ${guestName} (Unit ${unitLabel}) is checking in and Mr. Khan is currently unavailable. A supplementary form with their reservation details was just emailed to ${conciergeEmail} — please check your inbox to grant property access. The guest has been asked to mention this email to you.`;
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
async function resolveConciergeReply({ guestName, unitLabel, sendEmail, escalate, notifySuccess, notifyConcierge, notifyAll = true }) {
  try {
    await sendEmail();
    // Front-desk SMS — fires on EVERY successful email (both regex AND AI paths, since both
    // route through here). NOT gated by notifyAll. Best-effort: a failure here is logged
    // loudly but never changes the guest reply or the host SMS.
    if (typeof notifyConcierge === 'function') {
      try { await notifyConcierge(); }
      catch (e) { console.error(`[concierge] ❗ concierge SMS FAILED (not delivered): ${e && e.message}`); }
    }
    if (notifyAll && typeof notifySuccess === 'function') {
      // best-effort, but NEVER silent — a swallowed host-SMS failure is how an
      // out-of-credits alert went unnoticed. Log loudly at error level.
      try { await notifySuccess(conciergeSentSms({ guestName, unitLabel })); }
      catch (e) { console.error(`[concierge] ❗ host success-SMS FAILED (not delivered): ${e && e.message}`); }
    }
    return { ok: true, reply: conciergeGuestReply(guestName) };
  } catch (err) {
    if (typeof escalate === 'function') {
      try { await escalate(err); }
      catch (e) { console.error(`[concierge] ❗ host escalation-SMS FAILED (not delivered): ${e && e.message}`); }
    }
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
  conciergeSms,
};
