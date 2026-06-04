// pricing-engine.js
// Peachtree Towers year-round pricing engine — compute layer.
// PURE / dependency-free so it's unit-testable. Reads the config, computes a
// price + min-stay for a given unit + date + booking state. Writes NOTHING.
// The runner (separate) fetches calendar state, calls this, previews, and pushes.
//
// Layer order: base -> seasonal -> day-of-week -> event override -> decay -> clamp(floor,ceiling)
//
// SAFETY: never returns a price below the applicable floor. Soft weekend floor
// ($99) holds Fri/Sat until within softFloorReleaseDaysOut of the date if still
// vacant, then releases toward hard floor. Hard floor is always the final stop.

'use strict';

function ymd(d) { return (d instanceof Date) ? d.toISOString().slice(0, 10) : String(d).slice(0, 10); }
function parseDate(s) { const d = new Date(s + 'T00:00:00Z'); return d; }
function daysBetween(fromYmd, toYmd) {
  const a = parseDate(ymd(fromYmd)), b = parseDate(ymd(toYmd));
  return Math.round((b - a) / 86400000);
}

// Find an event covering this date. A priceMode:"skip" event (e.g. World Cup, handled
// separately) takes HARD precedence over any overlapping event so the skip window is
// never priced — even if another event (Atlanta Market Summer 6/14, Ariana Grande 7/6–8)
// overlaps it. Among non-skip events, last match wins (later/more-specific overrides).
function eventFor(config, dateYmd) {
  let hit = null;
  let skipHit = null;
  for (const ev of config.events || []) {
    if (dateYmd >= ev.start && dateYmd <= ev.end) {
      if (ev.priceMode === 'skip') skipHit = ev;
      else hit = ev;
    }
  }
  return skipHit || hit;
}

// Resolve a min-stay spec: number, or [farOut, near] decaying by lead time.
function resolveMinStay(spec, leadDays) {
  if (spec == null) return null;
  if (typeof spec === 'number') return spec;
  if (Array.isArray(spec)) {
    const [farOut, near] = spec;
    // far-out dates get the HIGH (farOut) number; reduce toward `near` as date approaches
    return leadDays > 21 ? farOut : near;
  }
  return null;
}

// Decay multiplier from the step schedule, by lead time (days until the date).
function decayMult(config, leadDays) {
  const steps = (config.decay || []).slice().sort((a, b) => b.daysOut - a.daysOut);
  let mult = 1.0;
  for (const s of steps) {
    if (leadDays <= s.daysOut) mult = s.mult;
  }
  return mult;
}

/**
 * Compute price + min-stay for one unit, one date.
 * @param {object} config   the pricing-config.json object
 * @param {string} unitLabel  e.g. "4-L"
 * @param {string} dateYmd   "2026-09-04"
 * @param {object} opts      { todayYmd, isBooked }
 * @returns {object} { unit, date, price, minStay, floorUsed, layers, booked }
 */
function computeNight(config, unitLabel, dateYmd, opts = {}) {
  const unit = config.units[unitLabel];
  if (!unit) throw new Error(`Unknown unit ${unitLabel}`);
  const todayYmd = opts.todayYmd || ymd(new Date());
  const isBooked = !!opts.isBooked;
  const leadDays = daysBetween(todayYmd, dateYmd);

  const d = parseDate(dateYmd);
  const month = d.getUTCMonth() + 1;
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const isWeekend = (dow === 5 || dow === 6);

  const layers = {};
  const ev = eventFor(config, dateYmd);

  // ---- SKIP zone: engine must not touch these dates (e.g. World Cup, handled separately) ----
  if (ev && ev.priceMode === 'skip') {
    return {
      unit: unitLabel,
      date: dateYmd,
      skip: true,
      price: null,
      minStay: null,
      event: ev.name,
      booked: isBooked,
      leadDays: daysBetween(todayYmd, dateYmd),
      layers: { skip: ev.name }
    };
  }

  // ---- Price ----
  let price;
  if (ev && ev.priceMode === 'set') {
    // fixed price by unit type
    price = unit.type === '2BR'
      ? (ev.price2BR != null ? ev.price2BR : ev.price1BR)  // fall back if 2BR not given
      : ev.price1BR;
    layers.eventSet = price;
  } else {
    // base -> seasonal -> day-of-week
    const base = unit.base;
    const seas = (config.seasonal && config.seasonal[String(month)]) || 0;
    const dowAdj = (config.dayOfWeek && config.dayOfWeek[String(dow)]) || 0;
    price = base * (1 + seas) * (1 + dowAdj);
    layers.base = base; layers.seasonal = seas; layers.dayOfWeek = dowAdj;

    // event multiplier override (on top of computed)
    if (ev && ev.priceMode === 'mult') {
      price = price * ev.mult;
      layers.eventMult = ev.mult;
      // per-unit quality offset applies on event nights
      const adj = (config.perUnitAdj && config.perUnitAdj[unit.quality]) || 0;
      price = price * (1 + adj);
      layers.perUnitAdj = adj;
    }
  }

  // ---- Decay (only unbooked nights; NOT on fixed set-price events) ----
  const isSetPriceEvent = ev && ev.priceMode === 'set';
  if (!isBooked && !isSetPriceEvent) {
    const dm = decayMult(config, leadDays);
    price = price * dm;
    layers.decay = dm;
  } else if (isSetPriceEvent) {
    layers.decay = 'skipped(set-price event)';
  } else {
    layers.decay = 'skipped(booked)';
  }

  // ---- Floors ----
  const hardFloor = unit.floor;
  let floorUsed = hardFloor;
  if (isWeekend && !ev) {
    // soft weekend floor applies on normal weekends; releases near the date if vacant.
    // softWeekendFloor may be a single number (legacy) or a per-type map { "1BR": .., "2BR": .. }.
    const released = (!isBooked) && (leadDays <= (config.softFloorReleaseDaysOut || 2));
    const swf = config.softWeekendFloor;
    const swfVal = (swf && typeof swf === 'object') ? swf[unit.type] : swf;
    if (!released) floorUsed = Math.max(hardFloor, swfVal || hardFloor);
  }
  if (price < floorUsed) price = floorUsed;

  // ---- Ceiling ----
  if (price > unit.ceiling) price = unit.ceiling;

  price = Math.round(price);

  // ---- Min-stay ----
  const minStay = ev ? resolveMinStay(ev.minStay, leadDays) : null;

  return {
    unit: unitLabel,
    date: dateYmd,
    price,
    minStay,
    floorUsed,
    booked: isBooked,
    event: ev ? ev.name : null,
    leadDays,
    layers
  };
}

module.exports = { computeNight, eventFor, resolveMinStay, decayMult, daysBetween };
