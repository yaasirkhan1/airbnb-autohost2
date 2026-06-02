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

// A unit needs cleaning when the prior night was an actual RESERVATION (a guest,
// not a manual USER block) and the target day is not still occupied.
function needsCleaning(priorDay, targetDay) {
  return priorDay?.status?.reason === 'RESERVED' && targetDay?.status?.available !== false;
}

module.exports = { dateInTimeZone, dateOffset, tomorrowInTZ, needsCleaning };
