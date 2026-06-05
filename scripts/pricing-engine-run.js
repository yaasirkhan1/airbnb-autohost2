#!/usr/bin/env node
// Year-round pricing engine RUNNER with safety guardrails. Fetches live Hospitable
// calendar + booking state per managed unit, runs the pure engine, prints a PREVIEW.
// DEFAULT = DRY RUN — writes NOTHING.
//
//   node scripts/pricing-engine-run.js [--days N | --start YMD --end YMD] [--unit 4-L[,7-B]]
//        [--swing 40] [--confirm] [--batch [N]] [--override-sanity]
//        [--sanity-changed 80] [--sanity-move 60]
//
// Guardrails:
//   - Fail-closed fetch: a failed/empty/malformed calendar → SKIP the unit, write nothing.
//   - Unknown/ambiguous booking status → treated as BOOKED (never decayed).
//   - Run sanity check: if >X% of nights change or any move >Y%, HALT (needs --override-sanity).
//   - Overlap: skip wins, else higher-priced event wins; 2+ overlaps flagged in preview.
//   - --batch N: push in N-day slices, read-back-verify each, abort remaining on mismatch.
// Hospitable auth: HOSPITABLE_TOKEN from .env.
'use strict';
const fs = require('fs');
const path = require('path');
const { computeNight } = require('../src/pricing-engine');
const { isCalendarUsable, isNightBooked, isPushable, etToday, runSanityCheck } = require('../src/pricing-guards');
const R = require('../src/pricing-resilience');
const config = require('../src/pricing-config.json');

// Resilience artifact paths (data/ — gitignored runtime state).
const DATA = path.join(__dirname, '..', 'data');
const PATHS = {
  lock:      path.join(DATA, 'pricing-engine.lock'),
  audit:     path.join(DATA, 'pricing-audit.log'),
  runs:      path.join(DATA, 'pricing-runs.log'),
  alerts:    path.join(DATA, 'pricing-alerts.log'),
  lastOk:    path.join(DATA, 'pricing-last-success.json'),
  snapshots: path.join(DATA, 'snapshots'),
};
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const alert = (type, detail, extra) => R.emitAlert(R.buildAlert(type, detail, extra), { logFile: PATHS.alerts });

const TOK = (() => {
  const line = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
  const t = line ? line.slice('HOSPITABLE_TOKEN='.length).trim() : (process.env.HOSPITABLE_API_KEY || '');
  if (!t) { console.error('No HOSPITABLE_TOKEN in .env'); process.exit(1); }
  return t;
})();
const hos = async (method, p, body) => {
  try {
    const r = await fetch('https://public.api.hospitable.com/v2' + p, {
      method, headers: { Authorization: 'Bearer ' + TOK, Accept: 'application/json', 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { ok: r.ok, status: r.status, text: await r.text() };
  } catch (e) { return { ok: false, status: 0, text: String(e.message), netError: true }; }
};

const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseArgs(argv) {
  const a = { days: 365, swing: 40, confirm: false, units: null, start: null, end: null,
    batch: 0, overrideSanity: false, sanityChanged: 80, sanityMove: 60, sanityCoverage: 50,
    rollback: null, healthcheck: false, skipPreflight: false, noLock: false };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--confirm') a.confirm = true;
    else if (v === '--rollback') a.rollback = argv[++i];
    else if (v === '--healthcheck') a.healthcheck = true;
    else if (v === '--skip-preflight') a.skipPreflight = true;
    else if (v === '--no-lock') a.noLock = true;
    else if (v === '--override-sanity') a.overrideSanity = true;
    else if (v === '--batch') { const n = parseInt(argv[i + 1], 10); if (!isNaN(n)) { a.batch = n; i++; } else a.batch = 30; }
    else if (v === '--days') a.days = parseInt(argv[++i], 10);
    else if (v === '--swing') a.swing = parseInt(argv[++i], 10);
    else if (v === '--sanity-changed') a.sanityChanged = parseInt(argv[++i], 10);
    else if (v === '--sanity-move') a.sanityMove = parseInt(argv[++i], 10);
    else if (v === '--sanity-coverage') a.sanityCoverage = parseInt(argv[++i], 10);
    else if (v === '--unit') a.units = argv[++i].split(',').map(s => s.trim().toUpperCase());
    else if (v === '--start') a.start = argv[++i];
    else if (v === '--end') a.end = argv[++i];
  }
  return a;
}

// Fetch a single property object (for pre-flight ID/bedroom verification).
async function fetchProperty(propertyId) {
  const r = await hos('GET', `/properties/${propertyId}`);
  if (!r.ok) return { ok: false, error: `property fetch failed (HTTP ${r.status})` };
  let j; try { j = JSON.parse(r.text); } catch { return { ok: false, error: 'malformed property JSON' }; }
  return { ok: true, property: j?.data || j };
}

// Fetch a unit's calendar over [start,end] inclusive. Returns { ok, error, days, map }.
// ok=false on ANY chunk failure/malformed → caller fails closed (skips the unit).
async function fetchCalendar(propertyId, start, end) {
  const days = [];
  let chunkStart = start;
  while (chunkStart <= end) {
    const chunkEnd = addDays(chunkStart, 89) > end ? end : addDays(chunkStart, 89);
    const r = await hos('GET', `/properties/${propertyId}/calendar?start_date=${chunkStart}&end_date=${chunkEnd}`);
    if (!r.ok) return { ok: false, error: `fetch failed (HTTP ${r.status})`, days: [], map: {} };
    let j; try { j = JSON.parse(r.text); } catch { return { ok: false, error: 'malformed JSON', days: [], map: {} }; }
    const chunk = j?.data?.days || j?.days || (Array.isArray(j?.data) ? j.data : null);
    if (!Array.isArray(chunk)) return { ok: false, error: 'no days array in response', days: [], map: {} };
    days.push(...chunk);
    chunkStart = addDays(chunkEnd, 1);
    await new Promise(x => setTimeout(x, 120));
  }
  const map = {};
  for (const d of days) {
    map[d.date] = { price: d.price?.amount != null ? Math.round(d.price.amount / 100) : null, raw: d, minStay: d.min_stay ?? null };
  }
  return { ok: true, error: null, days, map };
}

// Read back a unit's calendar and verify the sent rows actually landed (price + min_stay).
// Tolerant of Hospitable's read-after-write lag: retries the read a few times before
// declaring a mismatch (a real write converges; a true no-op never does → still fails).
async function readBackVerify(propertyId, rows) {
  const start = rows[0].date, end = addDays(rows[rows.length - 1].date, 1);
  return R.verifyWithRetry(async (i) => {
    const cal = await fetchCalendar(propertyId, start, end);
    if (!isCalendarUsable(cal)) return { usable: false, reason: 'read-back fetch unusable' };
    const mismatches = [];
    for (const r of rows) {
      const got = cal.map[r.date];
      const gotPrice = got ? got.price : null;
      if (gotPrice !== r.computed) mismatches.push(`${r.date}: sent $${r.computed}, calendar shows $${gotPrice ?? '?'}`);
      else if (r.minStay != null && got && got.minStay !== r.minStay) mismatches.push(`${r.date}: min_stay sent ${r.minStay}, shows ${got.minStay}`);
    }
    if (mismatches.length && i === 0) console.log(`    ⏳ read-back stale (${mismatches.length} not yet visible), retrying for propagation…`);
    return { usable: true, mismatches };
  });
}

async function pushSlice(propertyId, rows) {
  const dates = rows.map(r => ({
    date: r.date, price: { amount: r.computed * 100 }, ...(r.minStay != null ? { min_stay: r.minStay } : {}),
  }));
  // #9 SELF-HEAL: transient errors (429/5xx/network) get bounded exponential backoff;
  // a 4xx (e.g. 422 dynamic pricing) is deterministic → no retry, fail-closed immediately.
  const r = await R.withRetry(async (attempt) => {
    if (attempt > 0) console.log(`    ↻ retry ${attempt} for ${propertyId} slice`);
    const resp = await hos('PUT', `/properties/${propertyId}/calendar`, { dates });
    if (resp.ok) return { ok: true, status: resp.status };
    return { ok: false, status: resp.status, netError: resp.netError, dynamic: R.isDynamicPricingError(resp.text), detail: String(resp.text).slice(0, 140) };
  });
  return r;
}

// ── #6 Dead-man's-switch check: alert (and exit non-zero) if no successful run recently ──
function doHealthcheck() {
  const last = R.readLastSuccess(PATHS.lastOk);
  const { stale, ageHours, lastSuccess } = R.isRunStale(last, { maxHours: 25 });
  if (stale) {
    alert('DEADMAN', `no successful pricing run in ${ageHours === Infinity ? 'EVER (no record)' : ageHours.toFixed(1) + 'h'} (>25h) — cron may be dead`, { lastSuccess });
    console.log(`DEAD-MAN: ⛔ STALE — last success ${lastSuccess || 'never'} (${ageHours === Infinity ? '∞' : ageHours.toFixed(1) + 'h'} ago)`);
    process.exit(4);
  }
  console.log(`DEAD-MAN: ok — last success ${lastSuccess} (${ageHours.toFixed(1)}h ago, < 25h)`);
}

// ── #12 ROLLBACK: restore every night in a snapshot to its exact pre-push price + min-stay ──
async function doRollback(args) {
  const snap = R.readJson(args.rollback);
  if (!snap || !Array.isArray(snap.units)) { console.error(`⛔ snapshot not found or invalid: ${args.rollback}`); process.exit(1); }
  const restore = R.snapshotToRollbackRows(snap);
  console.log(`ROLLBACK — snapshot ${args.rollback}`);
  console.log(`captured ${snap.capturedAt}${snap.runId ? ` (run ${snap.runId})` : ''} | ${args.confirm ? 'CONFIRM (restore)' : 'DRY RUN (preview only)'}\n`);

  for (const u of restore) {
    if (!u.rows.length) { console.log(`## ${u.label} — nothing to restore${u.skipped.length ? ` (${u.skipped.length} night(s) had no prior price — left untouched)` : ''}`); continue; }
    // Show before (current live) → after (snapshot value we will restore to).
    const start = u.rows[0].date, end = addDays(u.rows[u.rows.length - 1].date, 1);
    const live = await fetchCalendar(u.propertyId, start, end);
    console.log(`## ${u.label} — restoring ${u.rows.length} night(s)${u.skipped.length ? `, skipping ${u.skipped.length} with no prior price` : ''}`);
    for (const r of u.rows) {
      const cur = live.ok && live.map[r.date] ? live.map[r.date].price : '?';
      console.log(`  ${r.date}  live $${cur} → restore $${r.computed}  min:${r.minStay ?? '-'}`);
    }
  }

  if (!args.confirm) { console.log('\nDRY RUN — nothing restored. Re-run with --confirm to push the snapshot values back.'); return; }

  console.log('\n--confirm given — restoring prior values (read-back verified):');
  let restored = 0;
  for (const u of restore) {
    if (!u.rows.length) continue;
    const pr = await pushSlice(u.propertyId, u.rows);
    if (!pr.ok) {
      console.log(`  ${u.label}: ✗ restore failed (${pr.dynamic ? '422 dynamic pricing' : pr.status}) — ABORTING`);
      alert('PUSH_ABORTED', `rollback restore failed for ${u.label} (${pr.status})`);
      process.exit(3);
    }
    const v = await readBackVerify(u.propertyId, u.rows);
    if (!v.verified) {
      console.log(`  ${u.label}: pushed but READ-BACK MISMATCH (${(v.mismatches || [v.reason]).slice(0, 3).join('; ')}) — ABORTING`);
      alert('READBACK_MISMATCH', `rollback read-back mismatch for ${u.label}`, { mismatches: v.mismatches });
      process.exit(3);
    }
    R.buildAuditEntries(u.label, u.rows.map(r => ({ ...r, event: 'ROLLBACK' })), { runId: RUN_ID, source: 'rollback' })
      .forEach(e => R.appendJsonl(PATHS.audit, e));
    console.log(`  ${u.label}: restored + verified (${u.rows.length} nights)`);
    restored += u.rows.length;
  }
  console.log(`\nROLLBACK complete — ${restored} night(s) restored to pre-push values.`);
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  if (args.healthcheck) return doHealthcheck();
  if (args.rollback) return doRollback(args);

  // #3 PREVENT: validate config before anything else. Malformed config is the only path to
  // a garbage write (NaN/unbounded/negative/price-goes-up) → refuse to run, fail-closed.
  const cfgCheck = R.validateConfig(config);
  if (!cfgCheck.ok) {
    alert('CONFIG_INVALID', `${cfgCheck.errors.length} config error(s) — refusing to run`);
    console.error('⛔ CONFIG INVALID — refusing to run. Nothing fetched, nothing written:');
    cfgCheck.errors.forEach(e => console.error(`  ✗ ${e}`));
    process.exit(2);
  }

  const today = etToday(); // America/New_York, not UTC — evening runs keep the right lead-time
  const start = args.start || today;
  const end = args.end || addDays(start, args.days - 1);
  const unitLabels = args.units || Object.keys(config.units);

  console.log(`PRICING ENGINE RUN — ${start} → ${end} | units: ${unitLabels.join(', ')} | swing>${args.swing}% | ${args.confirm ? (args.batch ? `CONFIRM (batch ${args.batch})` : 'CONFIRM (push)') : 'DRY RUN'}`);
  console.log(`today=${today} | sanity: halt if >${args.sanityChanged}% change or any move >${args.sanityMove}%${args.overrideSanity ? ' (OVERRIDDEN)' : ''}\n`);

  let totalNights = 0, totalSwings = 0, totalBooked = 0, totalSkipped = 0, totalOverlaps = 0, totalClamps = 0;
  const skippedUnits = [];
  const allRows = [];      // for the run-level sanity check
  const pushQueue = [];
  const calMaps = {};      // propertyId → fetched calendar map (for #12 snapshot)

  for (const label of unitLabels) {
    const u = config.units[label];
    if (!u) { console.log(`\n## ${label} — NOT IN CONFIG, skipped, wrote nothing`); skippedUnits.push(`${label} (not in config)`); continue; }

    const cal = await fetchCalendar(u.propertyId, start, end);
    if (!isCalendarUsable(cal)) {  // FAIL-CLOSED: never compute against missing data
      console.log(`\n## ${label} — ⛔ could not fetch (${cal.error || 'unusable'}), skipped, wrote nothing`);
      skippedUnits.push(`${label} (${cal.error || 'unusable'})`);
      continue;
    }
    calMaps[u.propertyId] = cal.map;

    console.log(`\n## ${label} (${u.type}, ${u.quality}) — floor $${u.floor} ceiling $${u.ceiling}`);
    const rows = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const cd = cal.map[date];                       // may be undefined (missing day)
      const booked = isNightBooked(cd && cd.raw);      // unknown/missing → BOOKED (safe)
      const cur = cd ? cd.price : null;
      const res = computeNight(config, label, date, { todayYmd: today, isBooked: booked });
      const dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];

      // SKIP zone and BOOKED nights NEVER enter the push queue (isPushable). A booked
      // night the guest already holds is never repriced — shown but not queued.
      if (res.skip) {
        console.log(`  ${date} ${dow}  SKIP (${res.event} — handled separately)` + (booked ? '  [BOOKED]' : ''));
        totalSkipped++;
        continue;
      }
      if (!isPushable(res, booked)) { // booked
        console.log(`  ${date} ${dow}  $${cur ?? '?'}  [BOOKED — left alone, not repriced]`);
        totalBooked++;
        continue;
      }

      const delta = cur != null ? res.price - cur : null;
      const pct = cur ? Math.round((delta / cur) * 100) : null;
      const swing = pct != null && Math.abs(pct) > args.swing;
      totalNights++; if (swing) totalSwings++;

      let overlapStr = '';
      if (res.overlaps) {
        totalOverlaps++;
        const losers = res.overlaps.filter(o => o.name !== res.event).map(o => `${o.name.slice(0, 18)}→$${o.price}`).join(', ');
        overlapStr = `  ⚠OVERLAP won=[${(res.event || '').slice(0, 18)}→$${res.price}] over [${losers}]`;
      }
      let clampStr = '';
      if (res.clamped && res.clamped.onEvent) {
        totalClamps++;
        clampStr = `  ⚠CLAMP event price $${res.clamped.from}→$${res.clamped.to} (${res.clamped.bound})`;
      }

      rows.push({ date, computed: res.price, minStay: res.minStay, oldPrice: cur, newPrice: res.price,
        oldMinStay: cd ? cd.minStay : null, event: res.event, clamped: res.clamped });
      allRows.push({ oldPrice: cur, newPrice: res.price });
      const deltaStr = cur != null ? `Δ${delta >= 0 ? '+' : ''}$${delta} (${pct >= 0 ? '+' : ''}${pct}%)` : 'Δ n/a';
      console.log(
        `  ${date} ${dow}  $${cur ?? '?'}→$${res.price}  ${deltaStr}  min:${res.minStay ?? '-'}` +
        (res.event ? `  [${res.event.slice(0, 24)}]` : '') + (swing ? '  ⚠SWING' : '') + overlapStr + clampStr
      );
    }
    pushQueue.push({ label, propertyId: u.propertyId, rows });
  }

  // ---- Run-level sanity check ----
  const sanity = runSanityCheck(allRows, { maxChangedPct: args.sanityChanged, maxMovePct: args.sanityMove, minCoveragePct: args.sanityCoverage });

  console.log(`\n================ SUMMARY ================`);
  console.log(`${totalNights} priced | ${totalSwings} swing>${args.swing}% | ${totalBooked} booked (left alone) | ${totalSkipped} WC-skip | ${totalOverlaps} overlap | ${totalClamps} event-clamp | ${skippedUnits.length} unit(s) skipped`);
  if (skippedUnits.length) console.log(`skipped units (wrote nothing): ${skippedUnits.join('; ')}`);
  console.log(`sanity: ${sanity.changedPct}% of ${sanity.totalWithCurrent} changed, ${sanity.coveragePct}% coverage, max move ${sanity.maxMovePct}% → ${sanity.halt ? '⛔ HALT' : 'ok'}`);
  if (sanity.halt) sanity.reasons.forEach(r => console.log(`  ✗ ${r}`));

  // ---- #7 DETECT: anomaly alerts (stub send) for skipped units ----
  for (const su of skippedUnits) alert('UNIT_SKIPPED', su);

  // ---- #5 DETECT: structured run summary, written every execution ----
  const writeSummary = (written, errors) => R.appendJsonl(PATHS.runs, R.buildRunSummary({
    runId: RUN_ID, window: `${start}..${end}`, priced: totalNights, skippedWC: totalSkipped,
    bookedLeftAlone: totalBooked, halted: sanity.halt, unitsSkipped: skippedUnits,
    written, errors: errors || [], mode: args.confirm ? 'confirm' : 'dry-run',
  }));

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing written to Hospitable.');
    writeSummary(0);
    R.recordSuccess(PATHS.lastOk, { runId: RUN_ID, written: 0 });
    return;
  }

  // ---- Push gate: sanity HALT requires explicit override ----
  if (sanity.halt && !args.overrideSanity) {
    alert('SANITY_HALT', sanity.reasons.join('; '));
    console.log('\n⛔ PUSH HALTED by sanity check (signature of bad data). Nothing written.');
    console.log('   Re-run with --override-sanity to push anyway (only after you have verified the data).');
    writeSummary(0, ['sanity halt']);
    process.exit(3);
  }

  // ---- #4 PREVENT: single-flight cron lock (overlapping runs must not push concurrently) ----
  let lockHeld = false;
  if (!args.noLock) {
    const lk = R.acquireLock(PATHS.lock);
    if (!lk.acquired) {
      console.log(`\n⛔ another run holds the lock (pid ${lk.heldBy.pid}, since ${new Date(lk.heldBy.ts).toISOString()}). Exiting cleanly, wrote nothing.`);
      writeSummary(0, ['lock held']);
      return;
    }
    lockHeld = true;
  }

  try {
  // ---- #1/#2 PREVENT: pre-flight per unit — property-ID/bedroom verification + dynamic-pricing ----
  if (!args.skipPreflight) {
    console.log('\nPRE-FLIGHT (property mapping + dynamic-pricing):');
    for (const { label, propertyId } of pushQueue) {
      const u = config.units[label];
      const pf = await fetchProperty(propertyId);
      if (!pf.ok) { // fail-closed: can't verify mapping → don't write
        alert('MAPPING_DRIFT', `${label}: ${pf.error} — cannot verify, HALT`);
        console.log(`  ⛔ ${label}: ${pf.error} — cannot verify mapping, HALT (nothing written)`);
        writeSummary(0, ['preflight fetch failed']);
        process.exit(5);
      }
      const vm = R.verifyPropertyMapping(label, u, pf.property);
      if (!vm.ok) {
        vm.reasons.forEach(rsn => alert('MAPPING_DRIFT', rsn));
        console.log(`  ⛔ ${vm.reasons.join('; ')} — HALT, nothing written`);
        writeSummary(0, ['mapping drift']);
        process.exit(5);
      }
      if (R.detectDynamicPricingFromProperty(pf.property)) {
        alert('DYNAMIC_PRICING', `${label}: dynamic pricing enabled — two engines would fight`);
        console.log(`  ⛔ ${label}: dynamic pricing enabled — HALT, nothing written`);
        writeSummary(0, ['dynamic pricing on']);
        process.exit(5);
      }
      console.log(`  ✓ ${label}: id + bedrooms match, dynamic pricing off`);
    }
  }

  // ---- #12 ROLLBACK: snapshot current state of every night about to change, BEFORE any push ----
  const toChange = pushQueue.map(q => ({ ...q, rows: q.rows.filter(r => r.oldPrice == null || r.computed !== r.oldPrice) }))
    .filter(q => q.rows.length);
  const snapshot = R.buildSnapshot(toChange, calMaps, { runId: RUN_ID, window: `${start}..${end}` });
  const snapFile = path.join(PATHS.snapshots, `pricing-snapshot-${RUN_ID}.json`);
  fs.mkdirSync(PATHS.snapshots, { recursive: true });
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));
  console.log(`\n📸 snapshot saved: ${snapFile} (undo with: node scripts/pricing-engine-run.js --rollback ${snapFile} --confirm)`);

  console.log(`\n--confirm given — pushing${args.batch ? ` in ${args.batch}-day batches with read-back verify` : ''}:`);
  let totalWritten = 0;
  for (const { label, propertyId, rows } of pushQueue) {
    if (!rows.length) { console.log(`  ${label}: nothing to push`); continue; }
    const sliceSize = args.batch || rows.length;
    let aborted = false;
    for (let i = 0; i < rows.length && !aborted; i += sliceSize) {
      const slice = rows.slice(i, i + sliceSize);
      const span = `${slice[0].date}..${slice[slice.length - 1].date}`;
      const pr = await pushSlice(propertyId, slice);
      if (!pr.ok) {
        const why = pr.dynamic ? '⛔ BLOCKED 422 (dynamic pricing) — nothing written' : `✗ ${pr.status} ${pr.detail}${pr.gaveUp && R.isTransientError(pr) ? ` (gave up after ${pr.attempts} attempts)` : ''}`;
        console.log(`  ${label} [${span}]: ${why} — ABORTING remaining batches`);
        alert(pr.dynamic ? 'DYNAMIC_PRICING' : (R.isTransientError(pr) ? 'RETRY_EXHAUSTED' : 'PUSH_ABORTED'), `${label} [${span}] ${pr.status}`);
        aborted = true; break;
      }
      if (args.batch) {
        const v = await readBackVerify(propertyId, slice);
        if (!v.verified) {
          console.log(`  ${label} [${span}]: pushed but READ-BACK MISMATCH (${(v.mismatches || [v.reason]).slice(0, 2).join('; ')}) — ABORTING remaining batches`);
          alert('READBACK_MISMATCH', `${label} [${span}]`, { mismatches: v.mismatches });
          aborted = true; break;
        }
        R.buildAuditEntries(label, slice, { runId: RUN_ID }).forEach(e => R.appendJsonl(PATHS.audit, e));
        totalWritten += slice.length;
        console.log(`  ${label} [${span}]: pushed + verified (${slice.length} nights)`);
      } else {
        R.buildAuditEntries(label, slice, { runId: RUN_ID }).forEach(e => R.appendJsonl(PATHS.audit, { ...e, verified: false }));
        totalWritten += slice.length;
        console.log(`  ${label}: PUSHED ${pr.status} (${slice.length} nights, UNVERIFIED — use --batch for read-back)`);
      }
    }
  }
  console.log('\nNo half-state: a non-2xx response or a failed read-back writes/leaves nothing further and aborts remaining batches.');
  writeSummary(totalWritten);
  R.recordSuccess(PATHS.lastOk, { runId: RUN_ID, written: totalWritten });
  } finally {
    if (lockHeld) R.releaseLock(PATHS.lock);
  }
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
