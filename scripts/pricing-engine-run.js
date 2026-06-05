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
const { isCalendarUsable, isNightBooked, runSanityCheck } = require('../src/pricing-guards');
const config = require('../src/pricing-config.json');

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
    batch: 0, overrideSanity: false, sanityChanged: 80, sanityMove: 60 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--confirm') a.confirm = true;
    else if (v === '--override-sanity') a.overrideSanity = true;
    else if (v === '--batch') { const n = parseInt(argv[i + 1], 10); if (!isNaN(n)) { a.batch = n; i++; } else a.batch = 30; }
    else if (v === '--days') a.days = parseInt(argv[++i], 10);
    else if (v === '--swing') a.swing = parseInt(argv[++i], 10);
    else if (v === '--sanity-changed') a.sanityChanged = parseInt(argv[++i], 10);
    else if (v === '--sanity-move') a.sanityMove = parseInt(argv[++i], 10);
    else if (v === '--unit') a.units = argv[++i].split(',').map(s => s.trim().toUpperCase());
    else if (v === '--start') a.start = argv[++i];
    else if (v === '--end') a.end = argv[++i];
  }
  return a;
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
async function readBackVerify(propertyId, rows) {
  const start = rows[0].date, end = addDays(rows[rows.length - 1].date, 1);
  const cal = await fetchCalendar(propertyId, start, end);
  if (!isCalendarUsable(cal)) return { verified: false, reason: 'read-back fetch unusable' };
  const mismatches = [];
  for (const r of rows) {
    const got = cal.map[r.date];
    const gotPrice = got ? got.price : null;
    if (gotPrice !== r.computed) mismatches.push(`${r.date}: sent $${r.computed}, calendar shows $${gotPrice ?? '?'}`);
    else if (r.minStay != null && got && got.minStay !== r.minStay) mismatches.push(`${r.date}: min_stay sent ${r.minStay}, shows ${got.minStay}`);
  }
  return { verified: mismatches.length === 0, mismatches };
}

async function pushSlice(propertyId, rows) {
  const dates = rows.map(r => ({
    date: r.date, price: { amount: r.computed * 100 }, ...(r.minStay != null ? { min_stay: r.minStay } : {}),
  }));
  const r = await hos('PUT', `/properties/${propertyId}/calendar`, { dates });
  if (r.ok) return { ok: true, status: r.status };
  return { ok: false, status: r.status, dynamic: /dynamic pricing/i.test(r.text), detail: r.text.slice(0, 140) };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const today = ymd(new Date());
  const start = args.start || today;
  const end = args.end || addDays(start, args.days - 1);
  const unitLabels = args.units || Object.keys(config.units);

  console.log(`PRICING ENGINE RUN — ${start} → ${end} | units: ${unitLabels.join(', ')} | swing>${args.swing}% | ${args.confirm ? (args.batch ? `CONFIRM (batch ${args.batch})` : 'CONFIRM (push)') : 'DRY RUN'}`);
  console.log(`today=${today} | sanity: halt if >${args.sanityChanged}% change or any move >${args.sanityMove}%${args.overrideSanity ? ' (OVERRIDDEN)' : ''}\n`);

  let totalNights = 0, totalSwings = 0, totalBooked = 0, totalSkipped = 0, totalOverlaps = 0;
  const skippedUnits = [];
  const allRows = [];      // for the run-level sanity check
  const pushQueue = [];

  for (const label of unitLabels) {
    const u = config.units[label];
    if (!u) { console.log(`\n## ${label} — NOT IN CONFIG, skipped, wrote nothing`); skippedUnits.push(`${label} (not in config)`); continue; }

    const cal = await fetchCalendar(u.propertyId, start, end);
    if (!isCalendarUsable(cal)) {  // FAIL-CLOSED: never compute against missing data
      console.log(`\n## ${label} — ⛔ could not fetch (${cal.error || 'unusable'}), skipped, wrote nothing`);
      skippedUnits.push(`${label} (${cal.error || 'unusable'})`);
      continue;
    }

    console.log(`\n## ${label} (${u.type}, ${u.quality}) — floor $${u.floor} ceiling $${u.ceiling}`);
    const rows = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const cd = cal.map[date];                       // may be undefined (missing day)
      const booked = isNightBooked(cd && cd.raw);      // unknown/missing → BOOKED (safe)
      const cur = cd ? cd.price : null;
      const res = computeNight(config, label, date, { todayYmd: today, isBooked: booked });
      const dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];

      if (res.skip) {
        console.log(`  ${date} ${dow}  SKIP (${res.event} — handled separately)` + (booked ? '  [BOOKED]' : ''));
        totalSkipped++;
        continue;
      }

      const delta = cur != null ? res.price - cur : null;
      const pct = cur ? Math.round((delta / cur) * 100) : null;
      const swing = pct != null && Math.abs(pct) > args.swing;
      totalNights++; if (swing) totalSwings++; if (booked) totalBooked++;

      let overlapStr = '';
      if (res.overlaps) {
        totalOverlaps++;
        const losers = res.overlaps.filter(o => o.name !== res.event).map(o => `${o.name.slice(0, 18)}→$${o.price}`).join(', ');
        overlapStr = `  ⚠OVERLAP won=[${(res.event || '').slice(0, 18)}→$${res.price}] over [${losers}]`;
      }

      rows.push({ date, computed: res.price, minStay: res.minStay, oldPrice: cur, newPrice: res.price });
      allRows.push({ oldPrice: cur, newPrice: res.price });
      const deltaStr = cur != null ? `Δ${delta >= 0 ? '+' : ''}$${delta} (${pct >= 0 ? '+' : ''}${pct}%)` : 'Δ n/a';
      console.log(
        `  ${date} ${dow}  $${cur ?? '?'}→$${res.price}  ${deltaStr}  min:${res.minStay ?? '-'}` +
        (res.event ? `  [${res.event.slice(0, 24)}]` : '') + (booked ? '  [BOOKED]' : '') + (swing ? '  ⚠SWING' : '') + overlapStr
      );
    }
    pushQueue.push({ label, propertyId: u.propertyId, rows });
  }

  // ---- Run-level sanity check ----
  const sanity = runSanityCheck(allRows, { maxChangedPct: args.sanityChanged, maxMovePct: args.sanityMove });

  console.log(`\n================ SUMMARY ================`);
  console.log(`${totalNights} priced | ${totalSwings} swing>${args.swing}% | ${totalBooked} booked | ${totalSkipped} WC-skip | ${totalOverlaps} overlap | ${skippedUnits.length} unit(s) skipped`);
  if (skippedUnits.length) console.log(`skipped units (wrote nothing): ${skippedUnits.join('; ')}`);
  console.log(`sanity: ${sanity.changedPct}% of ${sanity.totalWithCurrent} nights would change, max move ${sanity.maxMovePct}% → ${sanity.halt ? '⛔ HALT' : 'ok'}`);
  if (sanity.halt) sanity.reasons.forEach(r => console.log(`  ✗ ${r}`));

  if (!args.confirm) { console.log('\nDRY RUN — nothing written to Hospitable.'); return; }

  // ---- Push gate: sanity HALT requires explicit override ----
  if (sanity.halt && !args.overrideSanity) {
    console.log('\n⛔ PUSH HALTED by sanity check (signature of bad data). Nothing written.');
    console.log('   Re-run with --override-sanity to push anyway (only after you have verified the data).');
    process.exit(3);
  }

  console.log(`\n--confirm given — pushing${args.batch ? ` in ${args.batch}-day batches with read-back verify` : ''}:`);
  for (const { label, propertyId, rows } of pushQueue) {
    if (!rows.length) { console.log(`  ${label}: nothing to push`); continue; }
    const sliceSize = args.batch || rows.length;
    let aborted = false;
    for (let i = 0; i < rows.length && !aborted; i += sliceSize) {
      const slice = rows.slice(i, i + sliceSize);
      const span = `${slice[0].date}..${slice[slice.length - 1].date}`;
      const pr = await pushSlice(propertyId, slice);
      if (!pr.ok) {
        console.log(`  ${label} [${span}]: ${pr.dynamic ? '⛔ BLOCKED 422 (dynamic pricing) — nothing written' : `✗ ${pr.status} ${pr.detail}`} — ABORTING remaining batches`);
        aborted = true; break;
      }
      if (args.batch) {
        const v = await readBackVerify(propertyId, slice);
        if (!v.verified) {
          console.log(`  ${label} [${span}]: pushed but READ-BACK MISMATCH (${(v.mismatches || [v.reason]).slice(0, 2).join('; ')}) — ABORTING remaining batches`);
          aborted = true; break;
        }
        console.log(`  ${label} [${span}]: pushed + verified (${slice.length} nights)`);
      } else {
        console.log(`  ${label}: PUSHED ${pr.status} (${slice.length} nights)`);
      }
    }
  }
  console.log('\nNo half-state: a non-2xx response or a failed read-back writes/leaves nothing further and aborts remaining batches.');
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
