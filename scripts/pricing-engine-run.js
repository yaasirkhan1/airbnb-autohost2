#!/usr/bin/env node
// Year-round pricing engine RUNNER. Fetches live Hospitable calendar + booking state
// for the managed units, runs the pure engine (src/pricing-engine.js) per unit × night,
// and prints a PREVIEW. DEFAULT = DRY RUN — writes NOTHING. --confirm attempts the push
// (expected to 422 on dynamic-pricing units; handled gracefully, no half-state).
//
//   node scripts/pricing-engine-run.js [--days N | --start YYYY-MM-DD --end YYYY-MM-DD]
//                                      [--unit 4-L[,7-B]] [--swing 40] [--confirm]
//
// Hospitable auth: reads HOSPITABLE_TOKEN from .env (same as the repo's other scripts).
'use strict';
const fs = require('fs');
const path = require('path');
const { computeNight } = require('../src/pricing-engine');
const config = require('../src/pricing-config.json');

const TOK = (() => {
  const line = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
  const t = line ? line.slice('HOSPITABLE_TOKEN='.length).trim() : (process.env.HOSPITABLE_API_KEY || '');
  if (!t) { console.error('No HOSPITABLE_TOKEN in .env'); process.exit(1); }
  return t;
})();
const hos = async (method, p, body) => {
  const r = await fetch('https://public.api.hospitable.com/v2' + p, {
    method, headers: { Authorization: 'Bearer ' + TOK, Accept: 'application/json', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { ok: r.ok, status: r.status, text: await r.text() };
};

const ymd = d => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return ymd(d); };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseArgs(argv) {
  const a = { days: 365, swing: 40, confirm: false, units: null, start: null, end: null };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--confirm') a.confirm = true;
    else if (v === '--days') a.days = parseInt(argv[++i], 10);
    else if (v === '--swing') a.swing = parseInt(argv[++i], 10);
    else if (v === '--unit') a.units = argv[++i].split(',').map(s => s.trim().toUpperCase());
    else if (v === '--start') a.start = argv[++i];
    else if (v === '--end') a.end = argv[++i];
  }
  return a;
}

// Fetch a unit's calendar over [start,end] inclusive → { date: {price, booked, minStay} }. Chunked.
async function fetchCalendar(propertyId, start, end) {
  const map = {};
  let chunkStart = start;
  while (chunkStart <= end) {
    const chunkEnd = addDays(chunkStart, 89) > end ? end : addDays(chunkStart, 89);
    const r = await hos('GET', `/properties/${propertyId}/calendar?start_date=${chunkStart}&end_date=${chunkEnd}`);
    if (r.ok) {
      let j; try { j = JSON.parse(r.text); } catch { j = {}; }
      const days = j?.data?.days || j?.days || (Array.isArray(j?.data) ? j.data : []);
      for (const d of days) {
        map[d.date] = {
          price: d.price?.amount != null ? Math.round(d.price.amount / 100) : null,
          booked: d.status?.available === false,
          minStay: d.min_stay ?? null,
        };
      }
    }
    chunkStart = addDays(chunkEnd, 1);
    await new Promise(x => setTimeout(x, 120));
  }
  return map;
}

async function pushUnit(label, rows) {
  // Verified shape (probed live): { dates: [ { date, price:{amount cents}, min_stay } ] }
  // — a flat array under `dates` (NOT {days:[...]}, which 400s). min_stay is the correct field.
  const propertyId = config.units[label].propertyId;
  const dates = rows.map(r => ({
    date: r.date, price: { amount: r.computed * 100 }, ...(r.minStay != null ? { min_stay: r.minStay } : {}),
  }));
  const r = await hos('PUT', `/properties/${propertyId}/calendar`, { dates });
  if (r.ok) return { ok: true, status: r.status };
  const dyn = /dynamic pricing/i.test(r.text);
  return { ok: false, status: r.status, dynamic: dyn, detail: r.text.slice(0, 140) };
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  const today = ymd(new Date());
  const start = args.start || today;
  const end = args.end || addDays(start, args.days - 1);
  const unitLabels = args.units || Object.keys(config.units);

  console.log(`PRICING ENGINE RUN — ${start} → ${end}  | units: ${unitLabels.join(', ')} | swing flag: >${args.swing}% | ${args.confirm ? 'CONFIRM (push)' : 'DRY RUN'}`);
  console.log(`today=${today}\n`);

  let totalNights = 0, totalSwings = 0, totalBooked = 0, totalSkipped = 0;
  const pushQueue = [];

  for (const label of unitLabels) {
    const u = config.units[label];
    if (!u) { console.log(`\n## ${label} — NOT IN CONFIG, skipping`); continue; }
    const cal = await fetchCalendar(u.propertyId, start, end);
    console.log(`\n## ${label} (${u.type}, ${u.quality}) — floor $${u.floor} ceiling $${u.ceiling}`);
    const rows = [];
    for (let date = start; date <= end; date = addDays(date, 1)) {
      const c = cal[date] || { price: null, booked: false, minStay: null };
      const res = computeNight(config, label, date, { todayYmd: today, isBooked: c.booked });

      // Engine SKIP zone (e.g. World Cup, handled separately): show it, NEVER queue it for
      // a push. Because skip dates never enter `rows`, they can't be written even with --confirm.
      if (res.skip) {
        const dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];
        console.log(`  ${date} ${dow}  SKIP (${res.event} — handled separately)` + (c.booked ? '  [BOOKED]' : ''));
        totalSkipped++;
        continue;
      }

      const cur = c.price;
      const delta = cur != null ? res.price - cur : null;
      const pct = cur ? Math.round((delta / cur) * 100) : null;
      const swing = pct != null && Math.abs(pct) > args.swing;
      totalNights++; if (swing) totalSwings++; if (c.booked) totalBooked++;
      rows.push({ date, computed: res.price, minStay: res.minStay, event: res.event });
      const dow = DOW[new Date(date + 'T00:00:00Z').getUTCDay()];
      const deltaStr = cur != null ? `Δ${delta >= 0 ? '+' : ''}$${delta} (${pct >= 0 ? '+' : ''}${pct}%)` : 'Δ n/a (no current)';
      console.log(
        `  ${date} ${dow}  $${cur ?? '?'}→$${res.price}  ${deltaStr}` +
        `  min:${res.minStay ?? '-'}` +
        (res.event ? `  [${res.event.slice(0, 28)}]` : '') +
        (c.booked ? '  [BOOKED]' : '') +
        (swing ? '  ⚠SWING' : '')
      );
    }
    pushQueue.push({ label, rows });
  }

  console.log(`\n================ SUMMARY ================`);
  console.log(`${totalNights} unit-nights priced | ${totalSwings} flagged >${args.swing}% | ${totalBooked} already booked | ${totalSkipped} SKIPPED (World Cup, never pushed)`);

  if (!args.confirm) {
    console.log('\nDRY RUN — nothing written to Hospitable.');
    return;
  }

  console.log('\n--confirm given — attempting push (expect 422 dynamic-pricing block):');
  for (const { label, rows } of pushQueue) {
    const r = await pushUnit(label, rows);
    if (r.ok) console.log(`  ${label}: PUSHED ${r.status}`);
    else if (r.dynamic) console.log(`  ${label}: ⛔ BLOCKED ${r.status} (dynamic pricing enabled) — nothing written`);
    else console.log(`  ${label}: ✗ ${r.status} — ${r.detail} — nothing written`);
  }
  console.log('\nNo half-state: a non-2xx response writes nothing for that unit.');
})().catch(e => { console.error('runner error:', e.message); process.exit(1); });
