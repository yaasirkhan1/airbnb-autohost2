'use strict';
// Manual overrides for the nightly 9 PM cleaning schedule. The host prompts Claude from their
// phone ("add 7-B to cleaning tomorrow" / "remove 4-L from cleaning tomorrow"); Claude POSTs to
// /api/cleaning-override, which records the override here. The live 9 PM run on Railway loads it,
// MERGES it into the auto-computed schedule before the SMS goes out, then EXPIRES it — it's
// date-keyed, so it can never affect a future night. Persisted to the mounted volume (STATE_DIR/
// DATA_DIR) so it survives a restart/redeploy between when it's set and when the cron fires.
const fs = require('fs');
const path = require('path');

const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'cleaning-overrides.json');

// ── pure logic (unit-tested) ────────────────────────────────────────────────

// Resolve a loose unit token ("7-B", "7b", "apt 7-b", "Apt 7-B") to its canonical CLEANING
// label ("Apt 7-B"), or null if it isn't a known unit.
function canonicalUnit(token, validLabels) {
  const key = s => String(s).toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^APT/, '');
  const want = key(token);
  if (!want) return null;
  return (validLabels || []).find(l => key(l) === want) || null;
}

// Record an add/remove for a date into the store. A later action supersedes an earlier opposite
// one for the same unit/date (so "add" then "remove" = remove). Returns a NEW store.
function recordOverride(store, dateStr, action, label) {
  const s = { ...(store || {}) };
  const day = { add: [], remove: [], ...(s[dateStr] || {}) };
  day.add = day.add.filter(u => u !== label);
  day.remove = day.remove.filter(u => u !== label);
  if (action === 'add') day.add = [...day.add, label];
  else if (action === 'remove') day.remove = [...day.remove, label];
  s[dateStr] = day;
  return s;
}

// Auto-expiry: keep only date keys >= todayStr (YYYY-MM-DD lexical compare). Past nights drop.
function pruneExpired(store, todayStr) {
  const out = {};
  for (const [d, v] of Object.entries(store || {})) if (d >= todayStr) out[d] = v;
  return out;
}

// A manual cleaning entry (regular priority, standard 11 AM vacancy), flagged manual so the SMS
// can mark it. Shape matches buildCleaningEntry's output in server.js.
function manualEntry(label) {
  return { label, priority: false, vacancyTime: '11:00AM', vacancyConfirmed: false, deadlineTime: null, deadlineConfirmed: false, manual: true };
}

// Merge an override {add:[label], remove:[label]} into the auto-computed entries: `remove` drops
// matching entries; `add` appends a manual entry for any unit not already scheduled (no dup, and
// never downgrades a real priority entry to a manual one).
function applyOverride(entries, override) {
  let merged = (entries || []).slice();
  const add = (override && override.add) || [];
  const remove = (override && override.remove) || [];
  if (remove.length) merged = merged.filter(e => !remove.includes(e.label));
  for (const label of add) if (!merged.some(e => e.label === label)) merged.push(manualEntry(label));
  return merged;
}

// ── persistence (impure) ─────────────────────────────────────────────────────
function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

module.exports = { canonicalUnit, recordOverride, pruneExpired, manualEntry, applyOverride, loadStore, saveStore, storePath };
