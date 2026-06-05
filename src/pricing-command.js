// Plain-language pricing command → Hospitable calendar writes (nightly price +
// minimum-night requirement). PURE / dependency-free so parsing + conflict logic are
// unit-testable. The CLI (scripts/pricing-cli.js) does the live fetch, preview render,
// confirm gate, and the actual push. Nothing here writes anything.

// Price floors/ceilings — same source of truth as the pricing engine (src/server.js).
const FLOORS = {
  '1BR': { floor: 175, ceiling: 799 },
  '2BR': { floor: 250, ceiling: 1199 },
};

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

const pad = n => String(n).padStart(2, '0');
const bedroomsToType = bd => (bd === 1 ? '1BR' : bd === 2 ? '2BR' : `${bd}BR`);

// "Sept 2–6" / "Sep 2-6" / "September 2 to 6" → { start, end, nights }. end = checkout
// (exclusive), so "Sept 2–6" = nights of the 2nd,3rd,4th,5th = 4 nights.
function parseDateRange(text, refDate = new Date()) {
  const m = String(text).match(
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\s*(?:–|—|-|to)\s*(\d{1,2})\b/i
  );
  if (!m) return null;
  const mon = MONTHS[m[1].toLowerCase()];
  const d1 = parseInt(m[2], 10), d2 = parseInt(m[3], 10);
  let year = refDate.getUTCFullYear();
  if (mon < refDate.getUTCMonth() + 1) year += 1; // month already passed → next year
  const start = `${year}-${pad(mon)}-${pad(d1)}`;
  const end = `${year}-${pad(mon)}-${pad(d2)}`;
  const nights = Math.round((Date.parse(end + 'T00:00:00Z') - Date.parse(start + 'T00:00:00Z')) / 86400000);
  return { start, end, nights };
}

// Calendar dates that get written = each night from start to end-1 (checkout excluded).
function nightDates(range) {
  const out = [];
  if (!range) return out;
  let d = Date.parse(range.start + 'T00:00:00Z');
  const end = Date.parse(range.end + 'T00:00:00Z');
  for (; d < end; d += 86400000) out.push(new Date(d).toISOString().slice(0, 10));
  return out;
}

function parseSelector(text) {
  const t = String(text);
  const units = [...t.matchAll(/\b(\d{1,2}-[A-Za-z])\b/g)].map(x => x[1].toUpperCase());
  const oneBed = /\b1[\s-]*bed/i.test(t) || /\b1[\s-]*br\b/i.test(t);
  const twoBed = /\b2[\s-]*bed/i.test(t) || /\b2[\s-]*br\b/i.test(t);
  const assertedType = oneBed ? '1BR' : twoBed ? '2BR' : null;
  // Specific units named → target those, but remember any asserted type so the preview
  // can flag a named unit that isn't actually that type (conflict b).
  if (units.length) return { type: 'units', units, assertedType };
  if (oneBed) return { type: '1BR' };
  if (twoBed) return { type: '2BR' };
  return { type: 'unknown' };
}

function parseClause(text, carryRange, refDate) {
  const selector = parseSelector(text);
  const priceM = String(text).match(/\$\s*(\d{2,5})/);
  const price = priceM ? parseInt(priceM[1], 10) : null;
  const minM = String(text).match(/(\d+)\s*[-\s]*night\s*min/i);
  const minNights = minM ? parseInt(minM[1], 10) : null;
  const dateRange = parseDateRange(text, refDate) || carryRange || null;
  return { raw: String(text).trim(), selector, price, minNights, dateRange };
}

// Parse a full command (clauses separated by ';'). A clause without an explicit date
// inherits the command's date range (carried forward, and back-filled from the first).
function parseCommand(text, refDate = new Date()) {
  const parts = String(text || '').split(';').map(s => s.trim()).filter(Boolean);
  const clauses = [];
  let carry = null;
  for (const part of parts) {
    const c = parseClause(part, carry, refDate);
    if (c.dateRange) carry = c.dateRange;
    clauses.push(c);
  }
  const firstRange = clauses.map(c => c.dateRange).find(Boolean) || null;
  for (const c of clauses) if (!c.dateRange) c.dateRange = firstRange;
  return clauses;
}

function resolveUnits(selector, unitList) {
  if (selector.type === '1BR') return unitList.filter(u => u.bedrooms === 1);
  if (selector.type === '2BR') return unitList.filter(u => u.bedrooms === 2);
  if (selector.type === 'units') return unitList.filter(u => selector.units.includes(u.label));
  return [];
}

// Build the preview: one row per (clause × matched unit) with old→new price, min-nights,
// nights affected, and any conflicts. unitList: [{id,label,bedrooms,name}].
// currentPriceByUnit: { [unitId]: number|null }. Pure — never writes.
function buildPreview(clauses, unitList, currentPriceByUnit = {}, floors = FLOORS) {
  const rows = [];
  for (const c of clauses) {
    const targets = resolveUnits(c.selector, unitList);
    const nights = c.dateRange ? c.dateRange.nights : null;

    // Clause-level validation (surfaced as a row so nothing is silently dropped).
    if (c.selector.type === 'unknown') { rows.push({ clause: c.raw, conflicts: ['UNPARSEABLE SELECTOR — could not tell which units'], blocked: true }); continue; }
    if (!c.dateRange) { rows.push({ clause: c.raw, conflicts: ['NO DATE RANGE parsed'], blocked: true }); continue; }
    if (c.price == null) { rows.push({ clause: c.raw, conflicts: ['NO PRICE parsed'], blocked: true }); continue; }
    if (!targets.length) { rows.push({ clause: c.raw, conflicts: [`NO UNITS matched selector (${c.selector.type})`], blocked: true }); continue; }

    for (const u of targets) {
      const conflicts = [];
      const reqType = c.selector.type === '1BR' || c.selector.type === '2BR'
        ? c.selector.type
        : (c.selector.type === 'units' ? (c.selector.assertedType || null) : null);
      const unitType = bedroomsToType(u.bedrooms);

      // (a) min-nights longer than the booking window → unbookable
      if (c.minNights != null && nights != null && c.minNights > nights) {
        conflicts.push(`MIN-NIGHTS ${c.minNights} > WINDOW ${nights} nights — UNBOOKABLE`);
      }
      // (b) unit doesn't match the requested type (guards against a wrong unit map)
      if (reqType && unitType !== reqType) {
        conflicts.push(`TYPE MISMATCH — unit is ${unitType}, requested ${reqType}`);
      }
      // (c) price below the set floor (and above ceiling, flagged too)
      const fc = floors[unitType];
      if (fc && c.price < fc.floor) conflicts.push(`PRICE $${c.price} BELOW FLOOR $${fc.floor}`);
      if (fc && c.price > fc.ceiling) conflicts.push(`PRICE $${c.price} ABOVE CEILING $${fc.ceiling}`);

      rows.push({
        clause: c.raw,
        unit: u.label,
        name: u.name,
        type: unitType,
        start: c.dateRange.start,
        end: c.dateRange.end,
        nights,
        oldPrice: Object.prototype.hasOwnProperty.call(currentPriceByUnit, u.id) ? currentPriceByUnit[u.id] : null,
        newPrice: c.price,
        minNights: c.minNights,
        conflicts,
        blocked: conflicts.length > 0,
      });
    }
  }
  return { rows, hasConflicts: rows.some(r => r.conflicts && r.conflicts.length) };
}

module.exports = {
  FLOORS, MONTHS, parseDateRange, nightDates, parseSelector, parseClause,
  parseCommand, resolveUnits, buildPreview, bedroomsToType,
};
