'use strict';
// Per-unit store for the check-in-instructions sweep: door (Schlage) code + Wi-Fi, keyed by unit.
// Stored in the mounted volume (STATE_DIR/DATA_DIR) — same persistence as cleaning overrides, NOT
// hardcoded in source — and updatable from the host's phone via authed endpoints
// (POST /api/door-code, POST /api/wifi).
//
// Store shape: { "21-I": { code, wifi_name?, wifi_password? }, ... }. A legacy bare-string value
// is read as { code: <string> } for backward-compat.
//
// SAFETY: every value is bound to exactly ONE unit. Resolution is always propertyId → unit label →
// THAT unit's record. getDoorCode/getWifi read only the requested unit's key — no default/other
// unit's code is ever returned (an unknown unit or unset code → null).
const fs = require('fs');
const path = require('path');

// The 7 managed units, as bare labels matching data/properties-map.json `label`.
const UNIT_LABELS = ['4-L', '7-B', '18-A', '21-D', '21-I', '23-N', '24-L'];

// Wi-Fi DEFAULT RULE: SSID = the unit label, password = this shared password. Per-unit explicit
// values (e.g. 7-B's ARRIS router, or 21-I's lowercase "21-i" SSID) override the default.
const DEFAULT_WIFI_PASSWORD = '9545522122';

const storePath = () =>
  path.join(process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'door-codes.json');

// Normalize a loose unit token ("21-I", "21i", "apt 21-I") to its canonical bare label, or null.
function canonicalUnit(token, validLabels = UNIT_LABELS) {
  const key = s => String(s || '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^APT/, '');
  const want = key(token);
  if (!want) return null;
  return (validLabels || []).find(l => key(l) === want) || null;
}

// A door code is 4–8 digits (Schlage keypad). Returns the digit string or null if invalid.
function normalizeCode(code) {
  const d = String(code == null ? '' : code).replace(/\D/g, '');
  return d.length >= 4 && d.length <= 8 ? d : null;
}

// A unit's record as an object. Legacy: a bare string value means { code: <string> }.
function _record(store, unit) {
  const v = (store || {})[unit];
  if (v == null) return null;
  return typeof v === 'string' ? { code: v } : v;
}

// Look up EXACTLY one unit's door code. Returns { unit, code } only for a known unit with a set
// code; otherwise null. Reads only the requested unit's key — never another unit's, never a default.
function getDoorCode(store, unitToken) {
  const unit = canonicalUnit(unitToken);
  if (!unit) return null;
  const rec = _record(store, unit);
  const code = rec && rec.code;
  return code && String(code).trim() ? { unit, code: String(code).trim() } : null;
}

// Resolve a unit's Wi-Fi. Explicit per-unit wifi_name/wifi_password win; otherwise the DEFAULT RULE
// (SSID = unit label, password = DEFAULT_WIFI_PASSWORD). Returns { unit, name, password } for a
// known unit, else null. Bound to the one unit — never another unit's network.
function getWifi(store, unitToken) {
  const unit = canonicalUnit(unitToken);
  if (!unit) return null;
  const rec = _record(store, unit) || {};
  return {
    unit,
    name: (rec.wifi_name && String(rec.wifi_name).trim()) || unit,
    password: (rec.wifi_password && String(rec.wifi_password).trim()) || DEFAULT_WIFI_PASSWORD,
  };
}

// Set one unit's door code (phone update). Throws on unknown unit / non-4–8-digit code so a bad
// value is never persisted. Preserves any existing Wi-Fi on the record. Returns a NEW store.
function setDoorCode(store, unitToken, code) {
  const unit = canonicalUnit(unitToken);
  if (!unit) throw new Error(`unknown unit "${unitToken}" — valid: ${UNIT_LABELS.join(', ')}`);
  const norm = normalizeCode(code);
  if (!norm) throw new Error(`invalid code "${code}" — must be 4–8 digits`);
  return { ...(store || {}), [unit]: { ..._record(store, unit), code: norm } };
}

// Set one unit's Wi-Fi (phone update). Throws on unknown unit / empty name or password. Preserves
// the existing door code on the record. Returns a NEW store.
function setWifi(store, unitToken, name, password) {
  const unit = canonicalUnit(unitToken);
  if (!unit) throw new Error(`unknown unit "${unitToken}" — valid: ${UNIT_LABELS.join(', ')}`);
  const n = String(name == null ? '' : name).trim();
  const p = String(password == null ? '' : password).trim();
  if (!n) throw new Error('wifi name (SSID) is required');
  if (!p) throw new Error('wifi password is required');
  return { ...(store || {}), [unit]: { ..._record(store, unit), wifi_name: n, wifi_password: p } };
}

// ── persistence (impure) ─────────────────────────────────────────────────────
function loadStore() { try { return JSON.parse(fs.readFileSync(storePath(), 'utf8')); } catch { return {}; } }
function saveStore(store) {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(store, null, 2));
}

module.exports = {
  UNIT_LABELS, DEFAULT_WIFI_PASSWORD, canonicalUnit, normalizeCode,
  getDoorCode, getWifi, setDoorCode, setWifi, loadStore, saveStore, storePath,
};
