'use strict';
// Manual PERCENTAGE price adjustment over a date range (optionally per-unit or all units) — the
// host's "lower prices June 20-29 5%" control. Reads each night's CURRENT live price, applies the
// percentage, clamps to the unit's [floor, ceiling], and pushes. BOOKED nights and nights with no
// live price are left alone (never repriced). The caller snapshots the prior prices first so the
// change is fully REVERSIBLE (push the `from` values back).
//
// Pure math here; the live calendar read / push / snapshot persistence are the caller's (server).
const fs = require('fs');
const path = require('path');

// One night's new price: current * (1 + pct/100), rounded, clamped to [floor, ceiling].
// pct is a signed percentage (-5 = "lower 5%", +10 = "raise 10%"). Returns { price, bound }
// where bound ∈ 'floor'|'ceiling'|null so a clamp is always visible, never silent.
function adjustPrice(current, pct, { floor, ceiling }) {
  if (typeof current !== 'number' || !isFinite(current)) return { price: current, bound: null };
  let price = Math.round(current * (1 + pct / 100));
  if (floor != null && price < floor)   return { price: floor,   bound: 'floor' };
  if (ceiling != null && price > ceiling) return { price: ceiling, bound: 'ceiling' };
  return { price, bound: null };
}

// Build the push rows for one unit from its live-calendar entries.
//   entries: [{ date, current, booked }]   (current = live nightly price in whole USD, or null)
//   pct:     signed percentage
//   bounds:  { floor, ceiling }
// Returns { rows, snapshot, skipped }:
//   rows     — [{ date, from, to, bound }] nights that will actually change (to !== from)
//   snapshot — [{ date, price: from }] prior prices for EVERY pushed night (revert source)
//   skipped  — [{ date, reason }] booked / no-price / unchanged nights (audit, never pushed)
function buildAdjustRows(entries, pct, bounds) {
  const rows = [], snapshot = [], skipped = [];
  for (const e of (entries || [])) {
    if (e.booked) { skipped.push({ date: e.date, reason: 'booked' }); continue; }
    if (typeof e.current !== 'number' || !isFinite(e.current)) { skipped.push({ date: e.date, reason: 'no_price' }); continue; }
    const { price, bound } = adjustPrice(e.current, pct, bounds);
    if (price === e.current) { skipped.push({ date: e.date, reason: 'unchanged' }); continue; }
    rows.push({ date: e.date, from: e.current, to: price, bound });
    snapshot.push({ date: e.date, price: e.current });
  }
  return { rows, snapshot, skipped };
}

// Inclusive YYYY-MM-DD range → array of dates. Lexical-safe.
function dateRange(start, end) {
  const out = [];
  const d = new Date(start + 'T00:00:00Z');
  const stop = new Date(end + 'T00:00:00Z');
  while (d <= stop) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}

// ── Reversible snapshot store ────────────────────────────────────────────────
// Each manual adjustment appends one record so the most recent can be reverted.
const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pricing-adjustments.json');

function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return []; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
  return store;
}

// Append a record { id, at, pct, start, end, units:[{id, snapshot:[{date,price}]}] }; keep last 50.
function recordAdjustment(store, record) {
  const next = [{ ...record, id: record.id || `adj_${Date.now()}`, at: record.at || new Date().toISOString() }, ...(store || [])];
  return next.slice(0, 50);
}

module.exports = { adjustPrice, buildAdjustRows, dateRange, storePath, loadStore, saveStore, recordAdjustment };
