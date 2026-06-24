'use strict';
// READ-ONLY decay/pricing status. Answers "is decay frozen?" and, for a date range, WHY each
// night would or wouldn't decay. Sends nothing and changes nothing — it only reports state by
// composing the same fence logic the engine/decay passes use:
//   • manual freeze  (pricing-freeze: isManualFreeze)      — engine + decay skip the night
//   • World Cup fill  (wc-fill: wcFenced)                   — WC-fill decay owns it, engine skips
//   • decay campaign  (pricing-decay: isDecayFenced)        — the 9am/3pm/7pm ratchet owns it
//   • UNFENCED        — the thrice-daily decay passes SKIP it; it's priced ONLY by the daily 9am
//                       engine, so it looks "stuck" on stable inputs until the decay-curve daysOut
//                       bucket crosses, a booking changes, or an event applies.
// Optional live calendar (price/availability) refines unfenced nights into at-floor vs would-drop
// and flags booked nights. Pure: all state is injected, so it's unit-testable with no network.

const { freezeWindow, isManualFreeze } = require('./pricing-freeze');
const { isDecayFenced, decayCampaignFor } = require('./pricing-decay');
const { wcFenced } = require('./wc-fill');

// Inclusive YYYY-MM-DD range → array of dates. Caps at 60 nights so a fat-fingered range can't
// fan out into a giant message / loop.
function dateRange(start, end, cap = 60) {
  const out = [];
  let d = start;
  while (d <= end && out.length < cap) {
    out.push(d);
    const dt = new Date(d + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() + 1);
    d = dt.toISOString().slice(0, 10);
  }
  return out;
}

// Classify ONE (unit, date) from the decay engine's perspective. `info` (optional) is
// { price, floor, booked } from the live calendar. Never throws.
function classifyNight({ unit, date, todayYmd, freezeStore, env, info }) {
  const reasons = [];
  if (info && info.booked === true) {
    reasons.push('booked — decay always skips booked nights');
    return mk('booked');
  }
  if (isManualFreeze(date, todayYmd, freezeStore)) {
    reasons.push('manual decay freeze active — the engine and every decay pass skip this night');
    return mk('frozen');
  }
  if (wcFenced(date, env)) {
    reasons.push('inside the World Cup fill window — owned by the WC-fill decay; the daily engine skips it');
    return mk('wc-fenced');
  }
  if (isDecayFenced(unit, date)) {
    const c = decayCampaignFor(unit, date);
    reasons.push(`in decay campaign "${c.name}" — ratchets down toward $${c.floor} on each 9am/3pm/7pm pass`);
    return mk('decay-campaign');
  }
  // Unfenced: the thrice-daily decay passes do NOT touch this night.
  reasons.push('NOT decay-fenced → the 9am/3pm/7pm decay passes skip it; priced only by the daily 9am engine');
  if (info && typeof info.price === 'number' && typeof info.floor === 'number') {
    if (info.price <= info.floor) reasons.push(`at floor ($${info.price} ≤ floor $${info.floor}) — no further automated drop is possible`);
    else reasons.push(`above floor ($${info.price} vs floor $${info.floor}) — the daily engine steps it down as the date nears`);
  }
  return mk('unfenced');

  function mk(verdict) {
    return { unit, date, verdict, booked: !!(info && info.booked), price: info?.price ?? null, floor: info?.floor ?? null, reasons };
  }
}

// Build the full read-only status. Args:
//   start, end   inclusive YYYY-MM-DD range
//   units        array of unit labels to report
//   todayYmd     anchor date for the freeze window
//   freezeStore  pricing-freeze store ({} when off)
//   env          for the WC kill-switch (default process.env)
//   calendar     optional { [unit]: { [date]: { price, floor, booked } } }
// Returns { freeze, nights, byDate, text }.
function buildDecayStatus({ start, end, units, todayYmd, freezeStore = {}, env = process.env, calendar = null } = {}) {
  const dates = dateRange(start, end);
  const win = freezeWindow(todayYmd, freezeStore);
  const nights = [];
  for (const date of dates) {
    for (const unit of units) {
      const info = calendar && calendar[unit] && calendar[unit][date] ? calendar[unit][date] : null;
      nights.push(classifyNight({ unit, date, todayYmd, freezeStore, env, info }));
    }
  }
  // Aggregate per date so the message stays compact (per-date summary, not unit×date spam).
  const byDate = dates.map(date => {
    const rows = nights.filter(n => n.date === date);
    const verdicts = [...new Set(rows.map(r => r.verdict))];
    const prices = rows.map(r => r.price).filter(p => typeof p === 'number');
    const booked = rows.filter(r => r.booked).length;
    const atFloor = rows.filter(r => r.verdict === 'unfenced' && typeof r.price === 'number' && typeof r.floor === 'number' && r.price <= r.floor).length;
    return { date, verdicts, booked, atFloor, priceMin: prices.length ? Math.min(...prices) : null, priceMax: prices.length ? Math.max(...prices) : null, count: rows.length };
  });

  const freezeLine = win
    ? `🧊 Decay freeze: ON — frozen ${win.start} → ${win.end} (${freezeStore.days} day window). Automation skips every night in that window.`
    : '🟢 Decay freeze: OFF — no active window.';

  const lines = [freezeLine, '', `Decay status ${start} → ${end} · units: ${units.length === 7 ? 'all' : units.join(', ')}`];
  for (const d of byDate) {
    const tags = d.verdicts.join('/');
    const price = d.priceMin != null ? ` · $${d.priceMin}${d.priceMax !== d.priceMin ? `–$${d.priceMax}` : ''}` : '';
    const extra = [d.booked ? `${d.booked} booked` : '', d.atFloor ? `${d.atFloor} at floor` : ''].filter(Boolean).join(', ');
    lines.push(`• ${d.date}: ${tags}${price}${extra ? ` · ${extra}` : ''}`);
  }
  // One-line explainer for the common "why isn't it changing" case — shown whenever any night in
  // the range is unfenced (the situation that confuses: decay passes skip it, engine holds steady).
  if (byDate.some(d => d.verdicts.includes('unfenced'))) {
    lines.push('', 'Unfenced nights are not touched by the 9am/3pm/7pm decay passes — they are priced only by the daily 9am engine, which holds steady on stable inputs and steps down only as the decay-curve lead-time bucket crosses (or when a booking/event changes).');
  }
  return { freeze: { active: !!win, window: win, days: freezeStore.days || 0 }, nights, byDate, text: lines.join('\n') };
}

module.exports = { buildDecayStatus, classifyNight, dateRange };
