// Pure safety guards for the pricing runner. No I/O — unit-testable. The runner wires
// these around the live fetch + push so bad/missing data can never produce a write.
'use strict';

// Fail-closed booking state. A night is only "available" (eligible to be repriced/decayed)
// when the calendar EXPLICITLY says available:true. Anything else — booked, blocked,
// missing status, missing day, malformed — is treated as BOOKED (leave alone). Never decay
// on ambiguity.
function bookingStateFromCalDay(day) {
  if (day && day.status && day.status.available === true) return 'available';
  return 'booked';
}
const isNightBooked = day => bookingStateFromCalDay(day) === 'booked';

// Is a unit's fetched calendar usable? Fail-closed: a failed/empty/malformed fetch means
// SKIP the unit and write nothing — never compute against missing data.
//   result: { ok:boolean, days:array, error?:string }
function isCalendarUsable(result) {
  if (!result || result.ok !== true) return false;
  if (!Array.isArray(result.days) || result.days.length === 0) return false;
  // every entry must look like a calendar day (has a date string)
  return result.days.every(d => d && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date));
}

// Run-level sanity check before any push. Bad data shows up as a huge fraction of nights
// changing or an enormous single move. rows: [{ oldPrice, newPrice, ... }] (already
// excludes skips). Returns { halt, changedCount, totalWithCurrent, changedPct, maxMovePct, reasons }.
function runSanityCheck(rows, opts = {}) {
  const maxChangedPct = opts.maxChangedPct != null ? opts.maxChangedPct : 80;
  const maxMovePct = opts.maxMovePct != null ? opts.maxMovePct : 60;
  let changedCount = 0, totalWithCurrent = 0, maxMovePctSeen = 0;
  for (const r of rows || []) {
    if (r == null || r.newPrice == null) continue;
    if (r.oldPrice == null) continue; // can't measure change without a current price
    totalWithCurrent++;
    if (r.newPrice !== r.oldPrice) changedCount++;
    if (r.oldPrice > 0) {
      const move = Math.abs((r.newPrice - r.oldPrice) / r.oldPrice) * 100;
      if (move > maxMovePctSeen) maxMovePctSeen = move;
    }
  }
  const changedPct = totalWithCurrent ? (changedCount / totalWithCurrent) * 100 : 0;
  const reasons = [];
  if (changedPct > maxChangedPct) reasons.push(`${changedPct.toFixed(0)}% of nights would change (> ${maxChangedPct}% threshold)`);
  if (maxMovePctSeen > maxMovePct) reasons.push(`max single price move ${maxMovePctSeen.toFixed(0)}% (> ${maxMovePct}% threshold)`);
  return {
    halt: reasons.length > 0,
    changedCount, totalWithCurrent,
    changedPct: Math.round(changedPct),
    maxMovePct: Math.round(maxMovePctSeen),
    reasons,
  };
}

module.exports = { bookingStateFromCalDay, isNightBooked, isCalendarUsable, runSanityCheck };
