#!/usr/bin/env node
// World Cup FILL runner — seeds each vacant Jun 14–26 night at current−7%, then ratchets it
// DOWN toward its per-date floor (game/shoulder/base, +15% weekend) on 9am/3pm/7pm ET passes,
// faster as arrival nears. Booked nights freeze. Decay never raises; never writes below floor.
// DRY-RUN by default; writes only with --confirm (read-back verified + snapshotted). Fail-closed.
//
//   node scripts/wc-fill-run.js --seed             # preview the one-time −7% seed
//   node scripts/wc-fill-run.js --seed --confirm   # apply the seed (live)
//   node scripts/wc-fill-run.js                     # preview a decay pass
//   node scripts/wc-fill-run.js --confirm           # push a decay step (cron: 9/15/19 ET)
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../src/pricing-resilience');
const config = require('../src/pricing-config.json');
const { isNightBooked, isCalendarUsable, etToday } = require('../src/pricing-guards');
const { WC_FILL, wcActive, wcFenced, wcFloor, wcMinStay, wcLabel, wcUnitType, wcSeed, wcDecayTarget } = require('../src/wc-fill');

const ROOT = path.join(__dirname, '..');
const CONFIRM = process.argv.includes('--confirm');
const SEED = process.argv.includes('--seed');
// Freeze the near-term window: the decay pass leaves any night this many days out (or closer)
// at its current price, so the host manages the most immediate dates manually. Dates further out
// keep decaying normally. Applies to the recurring DECAY pass only, never the one-time --seed.
const FREEZE_WITHIN_DAYS = 7;
const DATA = R.resolveDataDir(process.env, path.join(ROOT, 'data'));
const SNAP_DIR = path.join(DATA, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

const TOK = (() => {
  let envText = null;
  try { envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { /* Railway env */ }
  const t = R.resolveHospitableToken(envText, process.env);
  if (!t) { console.error('No Hospitable token'); process.exit(1); }
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
const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5);
const labelToId = lbl => (config.units[lbl] || {}).propertyId;
const etHourNow = () => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }).format(new Date()));

async function fetchCal(id, start, end) {
  const r = await hos('GET', `/properties/${id}/calendar?start_date=${start}&end_date=${end}`);
  if (!r.ok) return { ok: false, error: `fetch HTTP ${r.status}`, map: {} };
  let j; try { j = JSON.parse(r.text); } catch { return { ok: false, error: 'malformed JSON', map: {} }; }
  const days = j?.data?.days || [];
  if (!Array.isArray(days)) return { ok: false, error: 'no days array', map: {} };
  const map = {};
  for (const d of days) map[d.date] = { price: d.price?.amount != null ? Math.round(d.price.amount / 100) : null, min_stay: d.min_stay, raw: d };
  return { ok: true, days, map };
}
async function pushDays(id, rows) {
  return hos('PUT', `/properties/${id}/calendar`,
    { dates: rows.map(r => ({ date: r.date, price: { amount: r.to * 100 }, min_stay: wcMinStay(r.date) })) });
}

(async () => {
  const today = etToday();
  const etHour = etHourNow();
  console.log(`WC FILL — ${SEED ? 'SEED (−7%)' : 'DECAY'} ${CONFIRM ? '🔴 CONFIRM' : '🟢 DRY-RUN'} | today=${today} | etHour=${etHour}`);
  if (!wcActive()) { console.log('campaign INACTIVE (kill switch) — no-op'); return; }
  const units = [...WC_FILL.units1BR, ...WC_FILL.unit2BR];
  let totalPushed = 0;

  for (const lbl of units) {
    const id = labelToId(lbl);
    const type = wcUnitType(lbl);
    if (!id) { console.log(`\n## ${lbl}: not in pricing-config — skipped`); continue; }
    const cal = await fetchCal(id, WC_FILL.start, WC_FILL.end);
    if (!isCalendarUsable(cal)) { console.log(`\n## ${lbl}: ⛔ calendar unusable (${cal.error}) — wrote nothing`); continue; }
    console.log(`\n## ${lbl} (${type})`);
    const rows = [];
    for (let d = WC_FILL.start; d <= WC_FILL.end; d = addDays(d, 1)) {
      const cd = cal.map[d];
      if (isNightBooked(cd && cd.raw)) { console.log(`  ${d} ${wcLabel(d)}  [BOOKED — frozen]`); continue; }
      const daysOut = daysBetween(today, d);
      if (!SEED && daysOut <= FREEZE_WITHIN_DAYS) { console.log(`  ${d} ${wcLabel(d)}  [≤${FREEZE_WITHIN_DAYS}d out — FROZEN for manual control]`); continue; }
      const cur = cd ? cd.price : null;
      if (cur == null) { console.log(`  ${d} ${wcLabel(d)}  (no live price — skipped)`); continue; }
      const floor = wcFloor(type, d);
      const target = SEED ? wcSeed(cur, type, d) : wcDecayTarget(cur, type, d, daysBetween(today, d), etHour);
      if (target == null) { console.log(`  ${d}  (no target — skipped)`); continue; }
      if (target >= cur) { console.log(`  ${d} ${wcLabel(d)}  $${cur}  [no change (floor $${floor})]`); continue; }
      console.log(`  ${d} ${wcLabel(d)}  $${cur} → $${target}  (-$${cur - target}, floor $${floor}, min${wcMinStay(d)})`);
      rows.push({ date: d, from: cur, to: target });
    }
    if (CONFIRM && rows.length) {
      fs.mkdirSync(SNAP_DIR, { recursive: true });
      const snap = path.join(SNAP_DIR, `wcfill-${lbl}-${RUN_ID}.json`);
      fs.writeFileSync(snap, JSON.stringify({ capturedAt: new Date().toISOString(), runId: RUN_ID, unit: lbl, propertyId: id, rows: rows.map(r => ({ date: r.date, price: r.from })) }, null, 2));
      const pr = await pushDays(id, rows);
      if (!pr.ok) { console.log(`  ✗ push failed (HTTP ${pr.status}: ${pr.text.slice(0, 160)}) — nothing further for ${lbl}`); continue; }
      // Read-back with retry: the calendar is read-after-write eventually-consistent, so a
      // too-fast re-fetch returns stale prices. Retry a few times before declaring a mismatch.
      let rb, bad = rows;
      for (let attempt = 0; attempt < 4; attempt++) {
        await new Promise(r => setTimeout(r, 2500));
        rb = await fetchCal(id, rows[0].date, addDays(rows[rows.length - 1].date, 1));
        bad = isCalendarUsable(rb) ? rows.filter(r => !(rb.map[r.date] && rb.map[r.date].price === r.to)) : rows;
        if (!bad.length) break;
      }
      const msBad = isCalendarUsable(rb) ? rows.filter(r => rb.map[r.date] && rb.map[r.date].min_stay !== wcMinStay(r.date)) : [];
      if (bad.length) console.log(`  ⚠ price read-back mismatch on ${bad.length}: ${bad.map(b => b.date).join(', ')}`);
      else { console.log(`  ✓ pushed + verified ${rows.length} night(s)${msBad.length ? ` (⚠ min_stay not set on ${msBad.length})` : ''} | snapshot ${path.basename(snap)}`); totalPushed += rows.length; }
    }
  }
  if (!CONFIRM) console.log('\nDRY-RUN — nothing written. Add --confirm to apply.');
  else console.log(`\nWC FILL done — ${totalPushed} night(s) written.`);
})().catch(e => { console.error('wc-fill runner error:', e.message); process.exit(1); });
