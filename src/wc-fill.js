'use strict';
// World Cup June 14–30 FILL-pricing campaign for all vacant 1BR + 2BR units at 300 Peachtree.
//
// Model: SEED each vacant night at current−7% (never above current, never below floor), then
// RATCHET DOWN toward a per-date floor on 9am/3pm/7pm ET pushes — faster as the arrival date
// nears (proximity bands). A booked night FREEZES (runner skips it). Decay only ever LOWERS.
//
// Floors are tiered game/shoulder/base, with a +15% WEEKEND (Fri/Sat/Sun) uplift stacked on top.
//
// SELF-LIFTING FENCE: while a date is inside this window the 9 AM engine SKIPS it (this campaign
// owns the price). The window is a fixed past-bounded range, so once today passes Jun 26 the
// dates fall out of the engine's forward window on their own — units resume normal pricing, no
// manual teardown. KILL SWITCH: set active:false (or env WC_FILL_OFF=1) to disable instantly.

const WC_FILL = {
  active: true,                 // KILL SWITCH (also: env WC_FILL_OFF=1 disables)
  start: '2026-06-14',          // inclusive
  end:   '2026-06-30',          // inclusive (extended from 6/26 to fence Jun 27–30 so the −5% cut sticks past the 9am engine; self-lifts after 6/30)
  minStay: 2,
  // Host override (2026-06-10, extended 06-11 to 6/30): Jun 14–30 → 1-night min (capture
  // single-night bookings across the WC window). Outside this range the default (2) applies.
  minStayOverride: { start: '2026-06-14', end: '2026-06-30', value: 1 },
  seedCutPct: 0.07,             // SEED = current − 7%
  units1BR: ['4-L', '7-B', '18-A', '21-D', '23-N', '24-L'],
  unit2BR:  ['21-I'],
  games:    ['2026-06-15', '2026-06-18', '2026-06-21', '2026-06-24'],
  // base floors by unit class + label; weekend (Fri/Sat/Sun) adds +15% on top.
  floors:   { '1BR': { game: 124, shoulder: 114, base: 99 },
              '2BR': { game: 161, shoulder: 148, base: 129 } },
  weekendUpliftPct: 0.15,
  // Host override (2026-06-11): Jun 13–20 floor dropped per unit class — 1BR $72, 2BR $109 —
  // to let the fill decay chase lower on the soft early-WC nights. Other WC dates keep their
  // tiered game/shoulder/base + weekend floors. Applies only where wcFloor is consulted
  // (the WC-fenced dates, i.e. 14–20 in this range).
  floorOverride: { start: '2026-06-13', end: '2026-06-20', value: { '1BR': 72, '2BR': 109 } },
};

const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// game | shoulder (day before/after a game) | base
function wcLabel(date) {
  if (WC_FILL.games.includes(date)) return 'game';
  for (const g of WC_FILL.games) if (date === addDays(g, -1) || date === addDays(g, 1)) return 'shoulder';
  return 'base';
}
// Fri(5) / Sat(6) / Sun(0) in UTC (dates are date-only, tz-stable).
const isWeekend = date => [0, 5, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay());

// Per-date floor: a flat host override if the date is in floorOverride's range, else the
// tier floor with +15% weekend uplift. Whole dollars.
function wcFloor(unitType, date) {
  const o = WC_FILL.floorOverride;
  if (o && date >= o.start && date <= o.end) return o.value[unitType];
  const base = WC_FILL.floors[unitType][wcLabel(date)];
  return isWeekend(date) ? Math.round(base * (1 + WC_FILL.weekendUpliftPct)) : base;
}

// Per-date min-stay: the campaign default, unless a date falls in the host's min-stay override
// sub-range (Jun 14–20 → 1). The decay runner stamps THIS on every push so the cron never
// reverts it back to the default.
function wcMinStay(date) {
  const o = WC_FILL.minStayOverride;
  return (o && date >= o.start && date <= o.end) ? o.value : WC_FILL.minStay;
}

const wcActive = (env = process.env) => WC_FILL.active && env.WC_FILL_OFF !== '1';
// Is this date owned by the fill campaign right now? Engine uses this to skip it.
const wcFenced = (date, env) => wcActive(env) && date >= WC_FILL.start && date <= WC_FILL.end;
const wcUnitType = label => WC_FILL.unit2BR.includes(label) ? '2BR' : (WC_FILL.units1BR.includes(label) ? '1BR' : null);

// SEED target: current−7%, clamped to >= floor, but NEVER above current (decay never raises).
function wcSeed(curPrice, unitType, date) {
  if (typeof curPrice !== 'number' || !isFinite(curPrice)) return null;
  const floor = wcFloor(unitType, date);
  return Math.min(Math.max(Math.round(curPrice * (1 - WC_FILL.seedCutPct)), floor), Math.round(curPrice));
}

// Pushes per day by proximity: <=7d -> 3 ($1 at 9/15/19 = -$3/day); 8-20d -> 2 (-$2/day);
// 21-42d -> 1 (-$1/day); else 0. ET push slot: 9->0, 15->1, 19->2.
function wcStepsPerDay(daysToArrival) { return daysToArrival <= 7 ? 3 : daysToArrival <= 20 ? 2 : daysToArrival <= 42 ? 1 : 0; }
const wcSlot = etHour => etHour < 13 ? 0 : etHour < 17 ? 1 : 2;
// $ to drop on THIS push: $1 if this slot is within the day's step budget, else $0.
function wcPushStep(daysToArrival, etHour) { return wcSlot(etHour) < wcStepsPerDay(daysToArrival) ? 1 : 0; }

// DECAY target for one push: lower live price by this push's step, never below floor, never raise.
function wcDecayTarget(curPrice, unitType, date, daysToArrival, etHour) {
  if (typeof curPrice !== 'number' || !isFinite(curPrice)) return null;
  const floor = wcFloor(unitType, date);
  return Math.max(floor, Math.round(curPrice) - wcPushStep(daysToArrival, etHour));
}

module.exports = {
  WC_FILL, wcLabel, isWeekend, wcFloor, wcMinStay, wcActive, wcFenced, wcUnitType,
  wcSeed, wcStepsPerDay, wcSlot, wcPushStep, wcDecayTarget,
};
