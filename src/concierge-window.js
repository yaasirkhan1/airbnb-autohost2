// Tight "fragment burst" detector. A real split front-desk request is a run of
// CONSECUTIVE, very-short guest messages sent seconds apart — e.g.
// "Can you send reservation" / "To the front desk" / "Or call". We join ONLY
// such a burst (each ≤ maxWords words, gaps ≤ maxGapMs, ≥2 messages) so innocent
// full sentences that merely mention "send"/"front desk" are NOT merged.
// No side effects on require — unit-testable.

const isGuest = m => {
  const r = m.sender_role || m.sender_type || '';
  return r !== 'host' && r !== 'co-host' && r !== 'teammate';
};
const wordCount = s => String(s || '').trim().split(/\s+/).filter(Boolean).length;

function fragmentBurst(messages, { now = Date.now(), maxWords = 5, maxGapMs = 120000, maxMessages = 5 } = {}) {
  const guest = (messages || [])
    .filter(isGuest)
    .filter(m => (m.body || '').trim())
    .slice()
    .sort((a, b) => (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));
  if (guest.length < 2) return '';

  // Walk backward from the newest message, collecting consecutive SHORT messages
  // whose gaps stay within maxGapMs. Stop at the first long message or big gap.
  const run = [];
  let nextTs = null;
  for (let i = guest.length - 1; i >= 0 && run.length < maxMessages; i--) {
    const m = guest[i];
    if (wordCount(m.body) > maxWords) break;
    const ts = Date.parse(m.created_at);
    if (nextTs !== null && !Number.isNaN(ts) && !Number.isNaN(nextTs) && (nextTs - ts) > maxGapMs) break;
    run.unshift(m);
    nextTs = ts;
  }
  return run.length >= 2 ? run.map(m => m.body.trim()).join(' ') : '';
}

// Routing decision for an inbound guest message:
//   'process'  — has a reservation/inquiry → normal reply + concierge flow
//   'escalate' — NO booking but it's a front-desk request → SMS the host (the
//                guest can't be auto-replied, but a human must be alerted —
//                this is the Kedravious/Dekarius case)
//   'drop'     — no booking and not a front-desk request → ignore
function routeAction({ hasBooking, conciergeHit }) {
  if (hasBooking) return 'process';
  return conciergeHit ? 'escalate' : 'drop';
}

module.exports = { fragmentBurst, isGuest, wordCount, routeAction };
