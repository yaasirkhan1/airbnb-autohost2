'use strict';
// Manual overrides for the nightly 9 PM cleaning schedule. The host prompts Claude from their
// phone ("add 7-B to cleaning tomorrow" / "remove 4-L" / "add 24-L tomorrow, urgent, ready by
// 4pm"); Claude POSTs to /api/cleaning-override, which records the override here. The live 9 PM
// run on Railway loads it, MERGES it into the auto-computed schedule before the SMS goes out,
// then EXPIRES it — date-keyed, so it can never affect a future night. Persisted to the mounted
// volume (STATE_DIR/DATA_DIR) so it survives a restart/redeploy between set time and the cron.
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

// Normalize a ready-by time ("4pm", "4:00 PM", "4 p.m.", "16:00") to the schedule's "4:00PM"
// format. Returns null for empty input; passes through (stripped) anything unparseable.
function normalizeTime(s) {
  if (!s) return null;
  const m = /^(\d{1,2})(?::(\d{2}))?\s*([ap]\.?m\.?)?$/i.exec(String(s).trim());
  if (!m) return String(s).replace(/\s+/g, '');
  let h = parseInt(m[1], 10); const min = m[2] || '00'; let ap = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!ap) { ap = h < 12 ? 'AM' : 'PM'; if (h === 0) h = 12; else if (h > 12) h -= 12; }
  else { ap = ap[0] === 'p' ? 'PM' : 'AM'; if (h === 0) h = 12; }
  return `${h}:${min}${ap}`;
}

const labelOf = a => (typeof a === 'string' ? a : a.label);

// Record an add/remove for a date into the store. `add` items are objects {label, priority,
// deadline}; `remove` items are labels. A later action supersedes an earlier one for the same
// unit/date. opts (add only): { priority: bool, deadline: 'H:MMAM/PM' }. Returns a NEW store.
function recordOverride(store, dateStr, action, label, opts = {}) {
  const s = { ...(store || {}) };
  const day = { add: [], remove: [], ...(s[dateStr] || {}) };
  day.add = day.add.filter(a => labelOf(a) !== label);
  day.remove = day.remove.filter(u => u !== label);
  if (action === 'add') day.add = [...day.add, { label, priority: !!opts.priority, deadline: opts.deadline || null }];
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

// A manual cleaning entry. opts: { priority: bool, deadline: 'H:MMAM/PM' }. A priority entry
// defaults its ready-by deadline to 4:00PM (same as an auto same-day turnover) if none given.
// Shape matches buildCleaningEntry's output in server.js.
function manualEntry(label, opts = {}) {
  const priority = !!opts.priority;
  return {
    label, priority,
    vacancyTime: '11:00AM', vacancyConfirmed: false,
    deadlineTime: opts.deadline || (priority ? '4:00PM' : null), deadlineConfirmed: false,
    manual: true,
  };
}

// Merge an override into the auto-computed entries: `remove` drops matching entries; `add`
// either appends a fresh manual entry (unit not yet scheduled) OR UPDATES the existing entry
// (unit already auto-scheduled) so an explicit host override can sharpen its ready-by deadline
// and/or escalate it to the urgent section. No dup, no drop. The "never downgrade a real
// priority" intent is preserved as an upgrade-only rule (true never flips to false); an explicit
// manual deadline always wins over the auto-computed one.
function applyOverride(entries, override) {
  let merged = (entries || []).slice();
  const add = (override && override.add) || [];
  const remove = (override && override.remove) || [];
  if (remove.length) merged = merged.filter(e => !remove.includes(e.label));
  for (const item of add) {
    const label = labelOf(item);
    const opts = typeof item === 'string' ? {} : { priority: item.priority, deadline: item.deadline };
    const idx = merged.findIndex(e => e.label === label);
    if (idx === -1) {
      merged.push(manualEntry(label, opts)); // not yet scheduled → append (unchanged behavior)
      continue;
    }
    // Already scheduled: update in place rather than skip. Copy (don't mutate the caller's entry).
    const cur = merged[idx];
    merged[idx] = {
      ...cur,
      priority:     cur.priority || !!opts.priority,        // upgrade-only; never downgrade
      deadlineTime: opts.deadline || cur.deadlineTime,      // explicit manual deadline wins
    };
  }
  return merged;
}

// ── persistence (impure) ─────────────────────────────────────────────────────
function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

module.exports = { canonicalUnit, normalizeTime, recordOverride, pruneExpired, manualEntry, applyOverride, loadStore, saveStore, storePath };
