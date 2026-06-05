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

// A night is eligible for the push ONLY if it's neither a skip date nor already booked.
// Booked nights are never repriced — they must not enter the push queue at all.
function isPushable(res, booked) {
  return !(res && res.skip) && !booked;
}

// Today's calendar date in the property's timezone (America/New_York), NOT UTC. A UTC
// "today" flips to the next day after ~8 PM ET, shifting lead-time and the decay step.
function etToday(date = new Date(), tz = 'America/New_York') {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Run-level sanity check before any push. HALTs on:
//   - >maxChangedPct of nights changing, or any single move >maxMovePct (bad-data spikes), OR
//   - low/zero current-price coverage (< minCoveragePct of nights have a current price) —
//     untrustworthy data must HALT, never read as "0% changed → safe".
// rows: [{ oldPrice, newPrice }] (already excludes skips and booked).
function runSanityCheck(rows, opts = {}) {
  const maxChangedPct = opts.maxChangedPct != null ? opts.maxChangedPct : 80;
  const maxMovePct = opts.maxMovePct != null ? opts.maxMovePct : 60;
  const minCoveragePct = opts.minCoveragePct != null ? opts.minCoveragePct : 50;
  let changedCount = 0, totalWithCurrent = 0, totalRows = 0, maxMovePctSeen = 0;
  for (const r of rows || []) {
    if (r == null || r.newPrice == null) continue;
    totalRows++;
    if (r.oldPrice == null) continue; // no current price → not measurable
    totalWithCurrent++;
    if (r.newPrice !== r.oldPrice) changedCount++;
    if (r.oldPrice > 0) {
      const move = Math.abs((r.newPrice - r.oldPrice) / r.oldPrice) * 100;
      if (move > maxMovePctSeen) maxMovePctSeen = move;
    }
  }
  const changedPct = totalWithCurrent ? (changedCount / totalWithCurrent) * 100 : 0;
  const coveragePct = totalRows ? (totalWithCurrent / totalRows) * 100 : 0;
  const reasons = [];
  if (totalRows > 0 && coveragePct < minCoveragePct) {
    reasons.push(`current-price coverage ${coveragePct.toFixed(0)}% (< ${minCoveragePct}% — data untrustworthy, cannot verify changes)`);
  }
  if (changedPct > maxChangedPct) reasons.push(`${changedPct.toFixed(0)}% of nights would change (> ${maxChangedPct}% threshold)`);
  if (maxMovePctSeen > maxMovePct) reasons.push(`max single price move ${maxMovePctSeen.toFixed(0)}% (> ${maxMovePct}% threshold)`);
  return {
    halt: reasons.length > 0,
    changedCount, totalWithCurrent, totalRows,
    changedPct: Math.round(changedPct),
    coveragePct: Math.round(coveragePct),
    maxMovePct: Math.round(maxMovePctSeen),
    reasons,
  };
}

module.exports = { bookingStateFromCalDay, isNightBooked, isCalendarUsable, isPushable, etToday, runSanityCheck };
