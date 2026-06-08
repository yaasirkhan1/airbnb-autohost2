'use strict';
// World Cup June 14–26 FILL-pricing campaign for all vacant 1BR + 2BR units at 300 Peachtree.
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
  end:   '2026-06-26',          // inclusive
  minStay: 2,
  seedCutPct: 0.07,             // SEED = current − 7%
  units1BR: ['4-L', '7-B', '18-A', '21-D', '23-N', '24-L'],
  unit2BR:  ['21-I'],
  games:    ['2026-06-15', '2026-06-18', '2026-06-21', '2026-06-24'],
  // base floors by unit class + label; weekend (Fri/Sat/Sun) adds +15% on top.
  floors:   { '1BR': { game: 124, shoulder: 114, base: 99 },
              '2BR': { game: 161, shoulder: 148, base: 129 } },
  weekendUpliftPct: 0.15,
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

// Per-date floor: tier floor, +15% on weekend dates, whole dollars.
function wcFloor(unitType, date) {
  const base = WC_FILL.floors[unitType][wcLabel(date)];
  return isWeekend(date) ? Math.round(base * (1 + WC_FILL.weekendUpliftPct)) : base;
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

// Pushes per day by proximity: <=10d -> 3 ($1 at 9/15/19 = -$3/day); 11-20d -> 2 (-$2/day);
// 21-42d -> 1 (-$1/day); else 0. ET push slot: 9->0, 15->1, 19->2.
function wcStepsPerDay(daysToArrival) { return daysToArrival <= 10 ? 3 : daysToArrival <= 20 ? 2 : daysToArrival <= 42 ? 1 : 0; }
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
  WC_FILL, wcLabel, isWeekend, wcFloor, wcActive, wcFenced, wcUnitType,
  wcSeed, wcStepsPerDay, wcSlot, wcPushStep, wcDecayTarget,
};
