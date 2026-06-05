// pricing-resilience.js
// Resilience + contingency layer for the pricing engine.
// Philosophy, in priority order:
//   1. PREVENT      — block the bad state before it can happen (pre-flight checks).
//   2. DETECT       — catch it fast and LOUD if prevention fails (summary, alerts, audit).
//   3. SELF-HEAL    — auto-recover ONLY for known, bounded, safe conditions (transient retry).
//   4. FAIL-CLOSED  — anything ambiguous → write nothing, leave the calendar untouched, alert.
//
// PURE where it can be: validation, comparison, classification, formatting, and snapshot
// shaping are all I/O-free and unit-testable. The few functions that must touch the disk
// (lock, audit log, dead-man timestamp) take an explicit path so tests can use a tmp dir.
'use strict';
const fs = require('fs');
const path = require('path');

// ───────────────────────────── shared tiny I/O helpers ─────────────────────────────
function ensureDir(p) { fs.mkdirSync(path.dirname(p), { recursive: true }); }
function appendJsonl(file, obj) { ensureDir(file); fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

// ── Environment resolution (works both locally and on Railway) ───────────────────────
// Hospitable token: prefer a local .env HOSPITABLE_TOKEN (dev laptop), else fall back to the
// process env (Railway injects HOSPITABLE_API_KEY — there is NO .env file there). Pure: the
// caller passes the .env file TEXT (or null if the file is absent/unreadable) + the env object.
function resolveHospitableToken(envText, env = process.env) {
  let fromFile = '';
  if (typeof envText === 'string') {
    const line = envText.split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
    if (line) fromFile = line.slice('HOSPITABLE_TOKEN='.length).trim();
  }
  return fromFile || env.HOSPITABLE_API_KEY || env.HOSPITABLE_TOKEN || '';
}

// Data dir for resilience artifacts (snapshots/audit/dead-man/lock). PRICING_DATA_DIR (e.g. a
// mounted Railway volume at /app/data) overrides the repo-relative default so artifacts persist
// across deploys. Pure.
function resolveDataDir(env, fallbackDir) {
  return (env && env.PRICING_DATA_DIR) || fallbackDir;
}

// ════════════════════════════════ PREVENTION ════════════════════════════════════════

// ── #3 Config integrity check ──────────────────────────────────────────────────────
// Validate the whole config BEFORE any compute. Returns { ok, errors:[...] }. The runner
// refuses to run on any error — a malformed config is the one path to a *garbage* write
// (NaN, unbounded, negative, price-goes-up). Fail-closed at the door.
const YMD = /^\d{4}-\d{2}-\d{2}$/;
function isRealYmd(s) {
  if (typeof s !== 'string' || !YMD.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s; // round-trips → real calendar date (rejects Feb 30)
}
function num(v) { return typeof v === 'number' && isFinite(v); }

function validateConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object') return { ok: false, errors: ['config is not an object'] };

  const units = config.units || {};
  if (!Object.keys(units).length) errors.push('no units defined');
  for (const [label, u] of Object.entries(units)) {
    if (!u || typeof u !== 'object') { errors.push(`${label}: unit is not an object`); continue; }
    for (const f of ['base', 'floor', 'ceiling']) {
      if (!num(u[f])) errors.push(`${label}: ${f} missing or not a finite number`);
    }
    if (num(u.base) && u.base <= 0) errors.push(`${label}: base must be > 0`);
    if (num(u.floor) && u.floor <= 0) errors.push(`${label}: floor must be > 0`);
    if (num(u.ceiling) && u.ceiling <= 0) errors.push(`${label}: ceiling must be > 0`);
    if (num(u.floor) && num(u.ceiling) && u.floor >= u.ceiling) errors.push(`${label}: floor ($${u.floor}) >= ceiling ($${u.ceiling})`);
    if (num(u.base) && num(u.ceiling) && u.base > u.ceiling) errors.push(`${label}: base ($${u.base}) > ceiling ($${u.ceiling})`);
    if (num(u.base) && num(u.floor) && u.base < u.floor) errors.push(`${label}: base ($${u.base}) < floor ($${u.floor})`);
    if (!u.propertyId) errors.push(`${label}: missing propertyId`);
    if (u.type !== '1BR' && u.type !== '2BR') errors.push(`${label}: type must be "1BR" or "2BR" (got ${JSON.stringify(u.type)})`);
  }

  // decay: every multiplier must be in (0, 1] — a mult > 1 makes the price go UP as the date nears.
  for (const s of config.decay || []) {
    if (!num(s.daysOut) || !num(s.mult)) { errors.push(`decay step malformed: ${JSON.stringify(s)}`); continue; }
    if (s.mult <= 0 || s.mult > 1.0) errors.push(`decay step daysOut=${s.daysOut}: mult ${s.mult} out of (0,1] (decay must never raise price)`);
  }

  // events: dates real and ordered; priced amounts sane; min-stay positive.
  for (const ev of config.events || []) {
    const tag = `event "${(ev && ev.name) || '?'}"`;
    if (!ev || typeof ev !== 'object') { errors.push(`${tag}: not an object`); continue; }
    if (!isRealYmd(ev.start)) errors.push(`${tag}: invalid start date ${JSON.stringify(ev.start)}`);
    if (!isRealYmd(ev.end)) errors.push(`${tag}: invalid end date ${JSON.stringify(ev.end)}`);
    if (isRealYmd(ev.start) && isRealYmd(ev.end) && ev.start > ev.end) errors.push(`${tag}: start ${ev.start} is after end ${ev.end}`);
    if (ev.priceMode === 'set') {
      if (!num(ev.price1BR) || ev.price1BR <= 0) errors.push(`${tag}: set-mode needs price1BR > 0`);
      if (ev.price2BR != null && (!num(ev.price2BR) || ev.price2BR <= 0)) errors.push(`${tag}: price2BR present but not > 0`);
    } else if (ev.priceMode === 'mult') {
      if (!num(ev.mult) || ev.mult <= 0) errors.push(`${tag}: mult-mode needs mult > 0`);
    } else if (ev.priceMode === 'glide') {
      if (!num(ev.startPrice1BR) || ev.startPrice1BR <= 0) errors.push(`${tag}: glide needs startPrice1BR > 0`);
      if (!num(ev.floor1BR) || ev.floor1BR <= 0) errors.push(`${tag}: glide needs floor1BR > 0`);
      if (num(ev.startPrice1BR) && num(ev.floor1BR) && ev.floor1BR > ev.startPrice1BR) errors.push(`${tag}: floor1BR ($${ev.floor1BR}) > startPrice1BR ($${ev.startPrice1BR})`);
      if (ev.startPrice2BR != null || ev.floor2BR != null) {
        if (!num(ev.startPrice2BR) || ev.startPrice2BR <= 0) errors.push(`${tag}: glide startPrice2BR present but not > 0`);
        if (!num(ev.floor2BR) || ev.floor2BR <= 0) errors.push(`${tag}: glide floor2BR present but not > 0`);
        if (num(ev.startPrice2BR) && num(ev.floor2BR) && ev.floor2BR > ev.startPrice2BR) errors.push(`${tag}: floor2BR ($${ev.floor2BR}) > startPrice2BR ($${ev.startPrice2BR})`);
      }
      for (const [k, ms] of [['minStayHigh', ev.minStayHigh], ['minStayLow', ev.minStayLow]]) {
        if (ms != null && (!num(ms) || ms <= 0 || !Number.isInteger(ms))) errors.push(`${tag}: ${k} (${ms}) must be a positive integer`);
      }
      if (num(ev.minStayHigh) && num(ev.minStayLow) && ev.minStayLow > ev.minStayHigh) errors.push(`${tag}: minStayLow (${ev.minStayLow}) > minStayHigh (${ev.minStayHigh})`);
      if (ev.easeStartDays != null && (!num(ev.easeStartDays) || ev.easeStartDays <= 0)) errors.push(`${tag}: easeStartDays must be > 0`);
    } else if (ev.priceMode !== 'skip') {
      errors.push(`${tag}: unknown priceMode ${JSON.stringify(ev.priceMode)}`);
    }
    for (const ms of [].concat(ev.minStay == null ? [] : ev.minStay)) {
      if (!num(ms) || ms <= 0 || !Number.isInteger(ms)) errors.push(`${tag}: minStay value ${ms} must be a positive integer`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ── #1 Property-ID verification ─────────────────────────────────────────────────────
// Map drift = the ID in config no longer points at the unit we think it does. Pure
// comparison of the fetched Hospitable property against the config unit. Returns
// { ok, reasons:[...] }. A bedroom-count mismatch is hard drift → HALT.
function expectedBedrooms(type) { return type === '2BR' ? 2 : 1; }
function verifyPropertyMapping(unitLabel, configUnit, fetchedProperty) {
  const reasons = [];
  if (!fetchedProperty || typeof fetchedProperty !== 'object') {
    return { ok: false, reasons: [`${unitLabel}: no property data returned for ${configUnit && configUnit.propertyId}`] };
  }
  const id = fetchedProperty.id || fetchedProperty.uuid;
  if (id && configUnit && id !== configUnit.propertyId) {
    reasons.push(`${unitLabel}: returned property id ${id} != config ${configUnit.propertyId}`);
  }
  const beds = fetchedProperty.capacity && fetchedProperty.capacity.bedrooms;
  if (beds != null && configUnit) {
    const want = expectedBedrooms(configUnit.type);
    if (beds !== want) reasons.push(`${unitLabel}: Hospitable says ${beds}BR, config says ${configUnit.type} (${want}BR) — mapping drift`);
  }
  return { ok: reasons.length === 0, reasons };
}

// ── #2 Dynamic-pricing detection ────────────────────────────────────────────────────
// Authoritative signal is the 422 at push time ("dynamic pricing enabled ... can not be
// made via the API"). isDynamicPricingError classifies any response body. Two engines
// fighting over one calendar is never safe → detection HALTs the unit.
function isDynamicPricingError(text) {
  return typeof text === 'string' && /dynamic pricing/i.test(text);
}
// Best-effort read-side flag from a fetched property object, if Hospitable exposes one.
// Returns true ONLY on an explicit positive; absence is NOT proof it's off (the 422 at
// push is the hard backstop), so callers must still fail-closed on the push-time 422.
function detectDynamicPricingFromProperty(p) {
  if (!p || typeof p !== 'object') return false;
  const flags = [p.dynamic_pricing, p.dynamic_pricing_enabled, p.pricing && p.pricing.dynamic,
    p.settings && p.settings.dynamic_pricing];
  return flags.some(f => f === true || f === 'enabled' || f === 'on');
}

// ── #4 Cron lock ────────────────────────────────────────────────────────────────────
// A run holds a lockfile so a second (overlapping cron) run can't push concurrently. A
// stale lock (older than maxAgeMs — a killed run that never released) is reclaimable.
function lockIsStale(lockData, now, maxAgeMs) {
  if (!lockData || !num(lockData.ts)) return true; // unreadable lock → treat as stale
  return (now - lockData.ts) > maxAgeMs;
}
// Returns { acquired, heldBy }. acquired:false means a fresh lock is held → caller exits cleanly.
function acquireLock(lockFile, { now = Date.now(), maxAgeMs = 2 * 60 * 60 * 1000, pid = process.pid } = {}) {
  ensureDir(lockFile);
  const existing = readJson(lockFile);
  if (existing && !lockIsStale(existing, now, maxAgeMs)) return { acquired: false, heldBy: existing };
  fs.writeFileSync(lockFile, JSON.stringify({ pid, ts: now }));
  return { acquired: true, heldBy: { pid, ts: now } };
}
function releaseLock(lockFile, { pid = process.pid } = {}) {
  const cur = readJson(lockFile);
  if (cur && cur.pid === pid) { try { fs.unlinkSync(lockFile); } catch {} return true; }
  return false; // someone else's lock — don't delete it
}

// ════════════════════════════════ SELF-HEALING ══════════════════════════════════════

// ── #9 Transient API errors → bounded exponential backoff, then give up + alert ──────
// Transient = worth retrying: network drop, 429, and 5xx. NEVER retry 4xx like 422/400/401
// — those are deterministic and would just hammer. Bounded tries; no infinite loop.
function isTransientError(res) {
  if (!res) return false;
  if (res.netError) return true;
  const s = res.status;
  return s === 429 || (s >= 500 && s <= 599);
}
// fn returns a result object { ok, status, ... }. Retries while !ok && isTransientError,
// up to `retries` extra attempts, backing off baseMs * 2^n. sleep is injectable for tests.
async function withRetry(fn, { retries = 3, baseMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let attempt = 0, res;
  for (;;) {
    res = await fn(attempt);
    if (res && res.ok) return { ...res, attempts: attempt + 1 };
    if (attempt >= retries || !isTransientError(res)) return { ...res, attempts: attempt + 1, gaveUp: true };
    await sleep(baseMs * Math.pow(2, attempt));
    attempt++;
  }
}

// ── #14 read-after-write tolerance: don't false-abort on propagation lag ──────────────
// A PUT can land while an immediate read still returns the stale value (Hospitable is
// eventually consistent). Retry the verify a few times before declaring a mismatch: a real
// write CONVERGES within a couple of seconds; a true silent no-op NEVER converges and still
// fails after all attempts. readOnce(i) returns { usable, reason?, mismatches:[...] }.
async function verifyWithRetry(readOnce, { attempts = 5, delayMs = 2000, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last = { verified: false, reason: 'no read attempted' };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) await sleep(delayMs);
    const r = await readOnce(i);
    if (!r || !r.usable) { last = { verified: false, reason: (r && r.reason) || 'read-back fetch unusable', attempts: i + 1 }; continue; }
    if (!r.mismatches || r.mismatches.length === 0) return { verified: true, attempts: i + 1 };
    last = { verified: false, mismatches: r.mismatches, attempts: i + 1 };
  }
  return last;
}

// ════════════════════════════════ ROLLBACK (#12) ════════════════════════════════════

// Snapshot the CURRENT calendar state (price + min-stay) for every night about to change,
// captured from the same fetch the run computed against — taken BEFORE any push. This is
// the undo button: snapshotToRollbackRows turns it back into pushable rows of prior values.
// pushQueue: [{ label, propertyId, rows:[{date, computed, oldPrice, ...}] }]
// calMaps:   { [propertyId]: map }  where map[date] = { price, minStay }
function buildSnapshot(pushQueue, calMaps, meta = {}) {
  const units = [];
  for (const { label, propertyId, rows } of pushQueue) {
    const map = (calMaps && calMaps[propertyId]) || {};
    const nights = rows.map(r => {
      const cur = map[r.date] || {};
      return { date: r.date, price: cur.price != null ? cur.price : null, minStay: cur.minStay != null ? cur.minStay : null };
    });
    units.push({ label, propertyId, nights });
  }
  return { capturedAt: new Date().toISOString(), ...meta, units };
}
// Convert a snapshot into push rows that restore the prior values. Skips nights whose
// prior price was unknown (null) — fail-closed: we never invent a price to "restore".
function snapshotToRollbackRows(snapshot) {
  const out = [];
  for (const u of (snapshot && snapshot.units) || []) {
    const rows = [];
    const skipped = [];
    for (const n of u.nights || []) {
      if (n.price == null) { skipped.push(n.date); continue; } // unknown prior → can't safely restore
      rows.push({ date: n.date, computed: n.price, minStay: n.minStay != null ? n.minStay : null });
    }
    out.push({ label: u.label, propertyId: u.propertyId, rows, skipped });
  }
  return out;
}

// ════════════════════════════════ DETECTION ═════════════════════════════════════════

// ── #8 Write audit log entries (one per night actually written) ──────────────────────
// Proves what the TOOL did vs a human vs a channel: timestamp, unit, date, old→new price
// and min-stay, and the trigger (event name / decay / base).
function buildAuditEntries(unitLabel, rows, { runId, source = 'pricing-engine' } = {}) {
  const ts = new Date().toISOString();
  return rows.map(r => ({
    ts, runId, source, unit: unitLabel, date: r.date,
    oldPrice: r.oldPrice != null ? r.oldPrice : null, newPrice: r.computed,
    oldMinStay: r.oldMinStay != null ? r.oldMinStay : null, newMinStay: r.minStay != null ? r.minStay : null,
    trigger: r.event || (r.clamped ? `clamp:${r.clamped.bound}` : 'decay/base'),
  }));
}

// ── #5 Run summary ───────────────────────────────────────────────────────────────────
function buildRunSummary(stats) {
  return {
    ts: new Date().toISOString(),
    runId: stats.runId,
    window: stats.window,
    priced: stats.priced || 0,
    skippedWC: stats.skippedWC || 0,
    bookedLeftAlone: stats.bookedLeftAlone || 0,
    halted: !!stats.halted,
    unitsSkipped: stats.unitsSkipped || [],
    written: stats.written || 0,
    errors: stats.errors || [],
    mode: stats.mode,
  };
}

// ── #7 Anomaly alert (stub send — structured so wiring SMS/email later is trivial) ───
// types: SANITY_HALT, UNIT_SKIPPED, READBACK_MISMATCH, MAPPING_DRIFT, DYNAMIC_PRICING,
//        CONFIG_INVALID, RETRY_EXHAUSTED, DEADMAN, PUSH_ABORTED
function buildAlert(type, detail, extra = {}) {
  return { ts: new Date().toISOString(), level: 'ALERT', type, detail, ...extra };
}
// Stub: prints a single grep-able ALERT line and (optionally) appends to a log. Swap the
// body for OpenPhone SMS / Resend email later — the call sites already pass structured data.
function emitAlert(alert, { logFile, log = console.error } = {}) {
  log(`[ALERT] ${alert.type}: ${alert.detail}`);
  if (logFile) { try { appendJsonl(logFile, alert); } catch {} }
  return alert;
}

// ── #6 Dead-man's-switch ─────────────────────────────────────────────────────────────
function recordSuccess(file, { runId, written, now = new Date() } = {}) {
  ensureDir(file);
  const rec = { lastSuccess: now.toISOString(), runId, written };
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return rec;
}
function readLastSuccess(file) { return readJson(file); }
// alerts if no successful run within maxHours. Returns { stale, ageHours, lastSuccess }.
function isRunStale(lastRec, { now = Date.now(), maxHours = 25 } = {}) {
  if (!lastRec || !lastRec.lastSuccess) return { stale: true, ageHours: Infinity, lastSuccess: null };
  const last = new Date(lastRec.lastSuccess).getTime();
  if (isNaN(last)) return { stale: true, ageHours: Infinity, lastSuccess: lastRec.lastSuccess };
  const ageHours = (now - last) / 3600000;
  return { stale: ageHours > maxHours, ageHours, lastSuccess: lastRec.lastSuccess };
}

module.exports = {
  // io helpers
  appendJsonl, readJson,
  // environment
  resolveHospitableToken, resolveDataDir,
  // prevention
  validateConfig, isRealYmd,
  expectedBedrooms, verifyPropertyMapping,
  isDynamicPricingError, detectDynamicPricingFromProperty,
  lockIsStale, acquireLock, releaseLock,
  // self-healing
  isTransientError, withRetry, verifyWithRetry,
  // rollback
  buildSnapshot, snapshotToRollbackRows,
  // detection
  buildAuditEntries, buildRunSummary, buildAlert, emitAlert,
  recordSuccess, readLastSuccess, isRunStale,
};
