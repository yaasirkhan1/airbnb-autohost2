'use strict';
// Manual DECAY FREEZE for a rolling N-day window from "today" — the host's "turn off decay up to
// 7 days out so I can set prices manually" control. While a freeze is active, the daily engine run
// AND every decay/wc-fill pass treat any date in [today, today+N] as hands-off (skip), so a price
// the host sets by hand is never ratcheted down or overwritten by automation.
//
// REVERSIBLE + SELF-EXPIRING: the store holds only the window length N (days) + when it was set.
// The window is recomputed from the CURRENT date on every read, so it rolls forward each day and
// `clearFreeze()` (or letting days run out) restores normal automated pricing with no other change.
// Respecting floors/sanity is automatic: freezing only SKIPS automation; it never writes a price.
const fs = require('fs');
const path = require('path');

const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'pricing-freeze.json');

const MAX_DAYS = 60; // sanity cap — a freeze can never be set further out than 60 days

// Pure date helper: add whole days to a YYYY-MM-DD string (UTC math, lexical-safe output).
function addDays(ymd, n) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
  return store;
}

// Build (do not persist) a freeze store for N days. Throws on a non-positive / out-of-range N so a
// fat-fingered "freeze decay for 0 days" can never silently disable nothing-or-everything.
function setFreeze(days, now = new Date()) {
  const n = Number(days);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DAYS) {
    throw new Error(`days must be an integer 1–${MAX_DAYS}`);
  }
  return { days: n, setAt: now.toISOString() };
}

const clearFreeze = () => ({});

// The active window [start, end] (inclusive) for a store, anchored at todayYmd, or null when off.
function freezeWindow(todayYmd, store) {
  if (!store || !store.days) return null;
  return { start: todayYmd, end: addDays(todayYmd, store.days) };
}

// Is automation frozen for this date right now? True iff a freeze is active and the date falls in
// [today, today+days]. Lexical YYYY-MM-DD compare is correct.
function isManualFreeze(dateYmd, todayYmd, store) {
  const w = freezeWindow(todayYmd, store);
  if (!w) return false;
  return dateYmd >= w.start && dateYmd <= w.end;
}

module.exports = { storePath, loadStore, saveStore, setFreeze, clearFreeze, freezeWindow, isManualFreeze, addDays, MAX_DAYS };
