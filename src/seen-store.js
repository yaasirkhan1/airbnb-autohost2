// Persistence + grace logic for the dedup set (seenMessageIds).
// No side effects on require — safe to unit-test.
const fs = require('fs');
const path = require('path');

// STATE_DIR (a Railway volume in prod) holds mutable runtime state that must
// survive restarts. Falls back to DATA_DIR, then the repo ./data, for back-compat.
const DEFAULT_FILE = path.join(
  process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'seen-messages.json'
);

const GRACE_MS = 5 * 60 * 1000;

/**
 * True if `createdAt` is within the last `windowMs` (i.e. too recent to safely
 * mark "seen" during warm-up). Compares as numeric epoch — NEVER as strings.
 * (The old bug compared an ISO timestamp "..T..Z" against a PHP-format
 * "Y-m-d H:i:s" string; 'T' (0x54) > ' ' (0x20) made every message look recent.)
 */
function isWithinGrace(createdAt, now = Date.now(), windowMs = GRACE_MS) {
  if (!createdAt) return false;
  const t = new Date(createdAt).getTime();
  if (Number.isNaN(t)) return false;
  return t > now - windowMs;
}

/** Load persisted seen-keys into a Set. Missing/corrupt file → empty Set. */
function loadSeen(file = DEFAULT_FILE) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/** Persist a Set of seen-keys atomically. Bounded to the most recent 2000. */
function saveSeen(set, file = DEFAULT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const arr = [...set].slice(-2000);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(arr));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// Parse a timestamp to epoch ms. Handles ISO ("…T…Z" / offset) and the PHP
// "Y-m-d H:i:s" UTC form that toHospitableDate() produces (space, no zone).
// Returns NaN if unparseable. Use for NUMERIC comparison — never compare these
// two formats as strings ('T' 0x54 sorts after ' ' 0x20).
function tsMs(s) {
  if (!s) return NaN;
  const iso = String(s).includes('T') ? s : String(s).replace(' ', 'T') + 'Z';
  return Date.parse(iso);
}

module.exports = { isWithinGrace, loadSeen, saveSeen, tsMs, DEFAULT_FILE, GRACE_MS };
