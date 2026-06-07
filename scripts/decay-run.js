#!/usr/bin/env node
// Vacancy DECAY runner — ratchets each fenced night's price down one step per pass
// (scheduled 9am/3pm/7pm ET), floored, skipping booked nights (a booked night freezes).
// DRY-RUN by default; writes only with --confirm. Fail-closed like the engine runner:
// an unusable calendar, a booked night, or a missing price is left alone — never pushed.
//
//   node scripts/decay-run.js            # preview (writes nothing)
//   node scripts/decay-run.js --confirm  # push the step (read-back verified, snapshotted)
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('../src/pricing-resilience');
const config = require('../src/pricing-config.json');
const { DECAY_CAMPAIGNS, decayStep } = require('../src/pricing-decay');
const { isNightBooked, isCalendarUsable, etToday } = require('../src/pricing-guards');

const ROOT = path.join(__dirname, '..');
const CONFIRM = process.argv.includes('--confirm');
const DATA = R.resolveDataDir(process.env, path.join(ROOT, 'data'));
const SNAP_DIR = path.join(DATA, 'snapshots');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

const TOK = (() => {
  let envText = null;
  try { envText = fs.readFileSync(path.join(ROOT, '.env'), 'utf8'); } catch { /* Railway: use env */ }
  const t = R.resolveHospitableToken(envText, process.env);
  if (!t) { console.error('No Hospitable token (.env HOSPITABLE_TOKEN or env HOSPITABLE_API_KEY/HOSPITABLE_TOKEN)'); process.exit(1); }
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
const labelToId = lbl => (config.units[lbl] || {}).propertyId;

async function fetchCal(id, start, end) {
  const r = await hos('GET', `/properties/${id}/calendar?start_date=${start}&end_date=${end}`);
  if (!r.ok) return { ok: false, error: `fetch HTTP ${r.status}`, days: [], map: {} };
  let j; try { j = JSON.parse(r.text); } catch { return { ok: false, error: 'malformed JSON', days: [], map: {} }; }
  const days = j?.data?.days || [];
  if (!Array.isArray(days)) return { ok: false, error: 'no days array', days: [], map: {} };
  const map = {};
  for (const d of days) map[d.date] = { price: d.price?.amount != null ? Math.round(d.price.amount / 100) : null, raw: d };
  return { ok: true, days, map };
}
async function pushDays(id, rows) {
  return hos('PUT', `/properties/${id}/calendar`, { dates: rows.map(r => ({ date: r.date, price: { amount: r.to * 100 } })) });
}

(async () => {
  const today = etToday(); // America/New_York
  console.log(`VACANCY DECAY — ${CONFIRM ? '🔴 CONFIRM' : '🟢 DRY-RUN'} | today=${today} | ${DECAY_CAMPAIGNS.length} campaign(s)`);
  let totalPushed = 0;

  for (const c of DECAY_CAMPAIGNS) {
    // Only price today-or-future nights inside the window. After window.end the start
    // clamps past the end → no nights → no-op (the fence has self-lifted).
    const start = c.start > today ? c.start : today;
    if (start > c.end) {
      console.log(`\n## ${c.name}: window ${c.start}..${c.end} is fully past (today ${today}) — no-op, fence self-lifted.`);
      continue;
    }
    for (const lbl of c.units) {
      const id = labelToId(lbl);
      if (!id) { console.log(`\n## ${lbl}: not in pricing-config.json — skipped`); continue; }
      console.log(`\n## ${lbl}  (${start}..${c.end}, step -$${c.step}, floor $${c.floor})`);
      const cal = await fetchCal(id, start, c.end);
      if (!isCalendarUsable(cal)) { console.log(`  ⛔ calendar unusable (${cal.error}) — wrote nothing for ${lbl}`); continue; }

      const rows = [];
      for (let d = start; d <= c.end; d = addDays(d, 1)) {
        const cd = cal.map[d];
        const booked = isNightBooked(cd && cd.raw);   // unknown/missing → BOOKED (fail-closed)
        const cur = cd ? cd.price : null;
        if (booked) { console.log(`  ${d}  $${cur ?? '?'}  [BOOKED — frozen, skipped]`); continue; }
        if (cur == null) { console.log(`  ${d}  (no live price — skipped)`); continue; }
        const next = decayStep(cur, c);
        if (next >= cur) { console.log(`  ${d}  $${cur}  [at floor $${c.floor} — no drop]`); continue; }
        console.log(`  ${d}  $${cur} → $${next}  (-$${cur - next})`);
        rows.push({ date: d, from: cur, to: next });
      }

      if (CONFIRM && rows.length) {
        fs.mkdirSync(SNAP_DIR, { recursive: true });
        const snapFile = path.join(SNAP_DIR, `decay-${lbl}-${RUN_ID}.json`);
        fs.writeFileSync(snapFile, JSON.stringify({ capturedAt: new Date().toISOString(), runId: RUN_ID, unit: lbl, propertyId: id, rows: rows.map(r => ({ date: r.date, price: r.from })) }, null, 2));
        const pr = await pushDays(id, rows);
        if (!pr.ok) { console.log(`  ✗ push failed (HTTP ${pr.status}) — nothing further for ${lbl}`); continue; }
        // read-back verify
        const rb = await fetchCal(id, rows[0].date, addDays(rows[rows.length - 1].date, 1));
        const bad = isCalendarUsable(rb) ? rows.filter(r => !(rb.map[r.date] && rb.map[r.date].price === r.to)) : rows;
        if (bad.length) console.log(`  ⚠ read-back mismatch on ${bad.length} night(s): ${bad.map(b => b.date).join(', ')}`);
        else { console.log(`  ✓ pushed + verified ${rows.length} night(s) | snapshot ${path.basename(snapFile)}`); totalPushed += rows.length; }
      }
    }
  }
  if (!CONFIRM) console.log('\nDRY-RUN — nothing written. Add --confirm to push the step.');
  else console.log(`\nDECAY done — ${totalPushed} night(s) stepped down.`);
})().catch(e => { console.error('decay runner error:', e.message); process.exit(1); });
