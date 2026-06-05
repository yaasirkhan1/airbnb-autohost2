// Pure date + selection helpers for the nightly cleaning schedule.
// No side effects on require — unit-testable.

// Calendar date (YYYY-MM-DD) of `date` as seen in timezone `tz`.
// 'en-CA' formats as YYYY-MM-DD. This is what fixes the 9PM-ET-vs-UTC bug:
// at 9PM Eastern the UTC date has already rolled to the next day, so formatting
// in UTC was off by one. We compute the date in the cron's own timezone.
function dateInTimeZone(date, tz) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const g = t => parts.find(p => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

// Add `days` to a YYYY-MM-DD string (date-only; noon-UTC anchor avoids DST edges).
function dateOffset(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Tomorrow" relative to the cron's timezone (default America/New_York).
function tomorrowInTZ(now = new Date(), tz = 'America/New_York') {
  return dateOffset(dateInTimeZone(now, tz), 1);
}

// Reservation statuses that do NOT represent a real, calendar-occupying stay — these never
// imply a cleaning. Denylist (not allowlist) on purpose: an UNKNOWN status is treated as
// active so we err toward flagging a cleaning rather than silently missing a turnover.
const DEAD_RESERVATION_STATUSES = new Set([
  'cancelled', 'canceled', 'declined', 'not_possible', 'not possible',
  'expired', 'denied', 'withdrawn', 'inquiry', 'request', 'pending',
]);
function isActiveReservation(r) {
  const s = String((r && (r.status || r.reservation_status)) || '').toLowerCase();
  return !DEAD_RESERVATION_STATUSES.has(s);
}

// A unit needs cleaning when a guest CHECKS OUT on the target date — a departure creates the
// turnover, period. Whether a NEW guest also checks in that same date does NOT change *whether*
// a cleaning is needed; it only raises the PRIORITY. A same-day turnover (checkout AND check-in
// on the target date) is the highest-priority cleaning, never a skip.
//   outgoing: reservations whose check_out === target date (active only)
//   incoming: reservations whose check_in  === target date (active only)
function classifyTurnover(outgoing, incoming) {
  const checkouts = (outgoing || []).length;
  const checkins  = (incoming  || []).length;
  return {
    needsCleaning:   checkouts > 0,
    sameDayTurnover: checkouts > 0 && checkins > 0,
    checkouts,
    checkins,
  };
}

module.exports = { dateInTimeZone, dateOffset, tomorrowInTZ, isActiveReservation, classifyTurnover };
