'use strict';
// Morning check-in sweep + direct-question catch.
//   • Sweep: each morning, for every reservation arriving TODAY that hasn't already been sent
//     check-in instructions, send the filled template to that guest's OWN thread.
//   • Direct-question catch: a guest asking how to check in / for the door code gets it immediately.
//
// SAFETY (matches the guardrails): never double-send (skip if already sent); the door code is bound
// to the reservation's OWN unit (resolveCheckin → that unit's code) so it can't leak cross-thread;
// if any required field is missing for a unit, DON'T send a broken message — skip and host-alert.
//
// Decision logic is pure (decideSweep / planForReservation) for testing; runSweep wires it to
// injected live deps and supports dryRun (compute the plan, send nothing).
const tmpl = require('./checkin-template');

// Guest asking how to check in / get in / for the code → send instructions now (don't wait for the sweep).
const CHECKIN_QUESTION_REGEX = new RegExp(
  'check[\\s-]?in\\s*(procedure|instructions?|info|details?|process|steps?)' +
  '|how\\s+(do|can)\\s+i\\s+(check[\\s-]?in|get\\s+in|get\\s+into|access|enter)' +
  '|how\\s+to\\s+(check[\\s-]?in|get\\s+in|access|enter)' +
  '|(where|how)\\s+do\\s+i\\s+go' +
  '|door\\s*code|entry\\s*code|access\\s*code|lock\\s*code|gate\\s*code' +
  '|get\\s+(in|into)\\s+(the\\s+)?(unit|condo|building|apartment|room)',
  'i',
);

// A line DISTINCTIVE to our check-in template — so detecting "already sent" matches the real
// instructions, not a casual "wifi"/"code" mention. (Verbatim from the Access Instructions line.)
const SENT_MARKER_REGEX = /check in with front desk to register/i;
const HOST_ROLES = new Set(['host', 'co-host', 'teammate']);

/** True if a HOST message in the thread already contains our check-in instructions. */
function wasCheckinSent(thread) {
  return (thread || []).some(m => HOST_ROLES.has(m.sender_role || m.sender_type) && SENT_MARKER_REGEX.test(m.body || ''));
}

/**
 * Decide what to do for ONE arriving reservation:
 *   { action: 'already_sent' | 'skip' | 'send', unit, guestName, message?, missing? }
 * 'skip' carries the missing fields (so the caller host-alerts instead of sending a broken message).
 */
function planForReservation(reservation, thread, propsMap, doorCodeStore, hostName) {
  const { fields, missing } = tmpl.resolveCheckin(reservation, propsMap, doorCodeStore, { hostName });
  const base = { unit: fields.unit || null, guestName: fields.guestName || null };
  if (wasCheckinSent(thread)) return { action: 'already_sent', ...base };
  if (missing.length) return { action: 'skip', ...base, missing };
  return { action: 'send', ...base, message: tmpl.renderCheckinInstructions(fields) };
}

/** Pure planner over a list of { reservation, thread, resourceType? }. */
function decideSweep(arrivals, propsMap, doorCodeStore, hostName) {
  const toSend = [], skipped = [], alreadySent = [];
  for (const a of (arrivals || [])) {
    const resId = a.reservation.id;
    const resourceType = a.resourceType || 'reservation';
    const p = planForReservation(a.reservation, a.thread, propsMap, doorCodeStore, hostName);
    if (p.action === 'send') toSend.push({ resId, resourceType, unit: p.unit, guestName: p.guestName, message: p.message });
    else if (p.action === 'skip') skipped.push({ resId, resourceType, unit: p.unit, guestName: p.guestName, missing: p.missing });
    else alreadySent.push({ resId, unit: p.unit, guestName: p.guestName });
  }
  return { toSend, skipped, alreadySent };
}

/** Host SMS summary text for a morning sweep plan. */
function summaryText(plan, dateStr) {
  const sent = plan.toSend.map(s => `${s.unit || '?'} (${s.guestName || 'guest'})`).join(', ') || 'none';
  let t = `🏨 Check-in sweep ${dateStr}: sent ${plan.toSend.length} [${sent}]; already had ${plan.alreadySent.length}.`;
  if (plan.skipped.length) {
    const skip = plan.skipped.map(s => `${s.unit || '?'} missing ${s.missing.join('/')}`).join('; ');
    t += ` ⚠️ SKIPPED ${plan.skipped.length} — handle manually: ${skip}`;
  }
  return t;
}

/**
 * Orchestrate the morning sweep. Deps are injected so this is testable and so the dry-run can pass
 * no-op send/sms. dryRun → compute the plan and send NOTHING (no guest messages, no host SMS).
 */
async function runSweep(deps) {
  const { today, listArrivals, fetchThread, send, smsHost, propsMap, doorCodeStore, hostName, dryRun = false } = deps;
  const reservations = await listArrivals(today);
  const arrivals = [];
  for (const r of reservations) {
    const thread = await fetchThread(r.id).catch(() => []);
    arrivals.push({ reservation: r, thread, resourceType: 'reservation' });
  }
  const plan = decideSweep(arrivals, propsMap, doorCodeStore, hostName);
  if (!dryRun) {
    for (const s of plan.toSend) {
      try { await send(s.resId, s.message, s.resourceType); }
      catch (e) { s.error = e.message; }
    }
    // Re-route any send failures into the skipped/alert bucket so the host hears about them.
    const failed = plan.toSend.filter(s => s.error);
    if (failed.length) plan.skipped.push(...failed.map(s => ({ ...s, missing: [`send_failed: ${s.error}`] })));
    if (smsHost) await smsHost(summaryText(plan, today));
  }
  return { ...plan, summary: summaryText(plan, today) };
}

module.exports = {
  CHECKIN_QUESTION_REGEX, SENT_MARKER_REGEX, wasCheckinSent,
  planForReservation, decideSweep, summaryText, runSweep,
};
