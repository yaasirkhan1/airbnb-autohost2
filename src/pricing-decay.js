// Date-scoped vacancy DECAY for specific units/nights — a RATCHET (unlike the sawtooth
// vacancy nudge): each pass reads the CURRENT live price and drops it one small step,
// floored, so it accumulates downward across passes (9am/3pm/7pm) until the night books
// or hits the floor. A booked night freezes (the runner skips it).
//
// SELF-LIFTING FENCE: while a (unit, date) is inside an active campaign window, the daily
// 9 AM engine run SKIPS that night (the decay cron owns its price, so the engine never
// overwrites the ratchet). Because a campaign is a FIXED, past-bounded date range, the
// fence needs NO manual un-fencing: once today passes window.end, those dates fall out of
// the engine's forward pricing window (which always starts at "today") on their own, and
// the units resume normal automated pricing with zero intervention.
'use strict';

// Active decay campaigns. `units` are engine labels; `start`/`end` are inclusive ISO dates
// (lexical compare is correct for YYYY-MM-DD). `step`/`floor` are whole dollars.
const DECAY_CAMPAIGNS = [
  {
    name: '4-L/24-L/18-A Jun 7–13 fill',
    units: ['4-L', '24-L', '18-A'],
    start: '2026-06-07',
    end:   '2026-06-13',   // inclusive — Jun 14+ left untouched
    step:  1,              // dollars dropped per push (9am/3pm/7pm ET)
    floor: 99,             // never push below this
  },
];

// The campaign owning this (unit, date), or null. Date-scoped → self-lifting.
function decayCampaignFor(unitLabel, dateYmd) {
  for (const c of DECAY_CAMPAIGNS) {
    if (c.units.includes(unitLabel) && dateYmd >= c.start && dateYmd <= c.end) return c;
  }
  return null;
}

// Is this (unit, date) decay-managed right now? The engine uses this to skip it.
const isDecayFenced = (unitLabel, dateYmd) => decayCampaignFor(unitLabel, dateYmd) != null;

// Pure one-step ratchet: lower the live price by `step`, never below `floor`, and never
// ABOVE the current price (so it's a no-op once at/below the floor). Returns the new price,
// or null on a non-numeric current price (caller then leaves the night alone).
function decayStep(currentPrice, { step, floor }) {
  if (typeof currentPrice !== 'number' || !isFinite(currentPrice)) return null;
  return Math.max(Math.round(currentPrice) - step, floor);
}

module.exports = { DECAY_CAMPAIGNS, decayCampaignFor, isDecayFenced, decayStep };
