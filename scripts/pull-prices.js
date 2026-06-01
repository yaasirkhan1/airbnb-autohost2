// READ-ONLY: pulls current nightly prices for the 7 live units over the next
// 120 days, excluding the World Cup blackout (2026-06-11..2026-07-16).
// No writes. Run: node scripts/pull-prices.js
const fs = require('fs');
const path = require('path');

const KEY = 'HOSPITABLE_TOKEN=';
const tok = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n').find(l => l.startsWith(KEY)).slice(KEY.length).trim();
const BASE = 'https://public.api.hospitable.com/v2';

const UNITS = [
  { unit: '4-L',  id: 'bbe43523-c42a-46b0-8235-7ad08ae990c9' },
  { unit: '7-B',  id: '1af8fdde-58ee-426e-8374-6530397347e8' },
  { unit: '18-A', id: '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc' },
  { unit: '21-D', id: '80c21aac-00eb-49af-9094-6792839ff5a4' },
  { unit: '21-I', id: '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c' },
  { unit: '23-N', id: '283977a3-3af3-4d90-8d95-b418a3014d90' },
  { unit: '24-L', id: '3e702102-a219-4c18-9f88-3a4d1ceb3825' },
];

const BLACKOUT_START = '2026-06-11';
const BLACKOUT_END   = '2026-07-16';

const ymd = d => d.toISOString().slice(0, 10);
const START = new Date('2026-06-01T00:00:00Z');
const END   = new Date(START.getTime() + 120 * 86400000); // 120 days
const startStr = ymd(START), endStr = ymd(END);

async function getDays(id) {
  const url = `${BASE}/properties/${id}/calendar?start_date=${startStr}&end_date=${endStr}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`${id}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()).data?.days || [];
}

const median = arr => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

(async () => {
  console.log(`Window: ${startStr} → ${endStr} (120 days), excluding blackout ${BLACKOUT_START}..${BLACKOUT_END}\n`);
  const summary = [];
  const grid = []; // {date, unit -> price} for CSV

  for (const u of UNITS) {
    const days = await getDays(u.id);
    const prices = [], minstays = new Set();
    let booked = 0;
    for (const d of days) {
      if (d.date >= BLACKOUT_START && d.date <= BLACKOUT_END) continue; // skip blackout
      const dollars = d.price?.amount != null ? d.price.amount / 100 : null;
      if (d.status && d.status.available === false) booked++;
      if (dollars != null) {
        prices.push(dollars);
        minstays.add(d.min_stay);
        grid.push({ date: d.date, unit: u.unit, price: dollars, min_stay: d.min_stay, available: d.status?.available !== false });
      }
    }
    summary.push({
      unit: u.unit,
      days: prices.length,
      booked,
      min: prices.length ? Math.min(...prices) : null,
      median: median(prices),
      max: prices.length ? Math.max(...prices) : null,
      minStay: [...minstays].sort((a, b) => a - b).join('/'),
    });
    await new Promise(r => setTimeout(r, 150));
  }

  // Print summary table
  const cols = ['unit', 'days', 'booked', 'min', 'median', 'max', 'minStay'];
  const head = { unit: 'UNIT', days: 'DAYS', booked: 'BOOKED', min: 'MIN $', median: 'MEDIAN $', max: 'MAX $', minStay: 'MIN-STAY' };
  const w = {}; cols.forEach(c => w[c] = Math.max(String(head[c]).length, ...summary.map(r => String(r[c] ?? '').length)));
  const fmt = r => cols.map(c => String(r[c] ?? '').padEnd(w[c])).join('  ');
  console.log(fmt(head));
  console.log(cols.map(c => '-'.repeat(w[c])).join('  '));
  summary.forEach(r => console.log(fmt(r)));

  // Save full day-by-day grid as CSV for detail
  const dates = [...new Set(grid.map(g => g.date))].sort();
  const byKey = {}; grid.forEach(g => byKey[`${g.date}|${g.unit}`] = g.price);
  const csv = ['date,' + UNITS.map(u => u.unit).join(',')];
  dates.forEach(dt => csv.push(dt + ',' + UNITS.map(u => byKey[`${dt}|${u.unit}`] ?? '').join(',')));
  const out = path.join(__dirname, 'price-pull.csv');
  fs.writeFileSync(out, csv.join('\n'));
  console.log(`\nFull day-by-day grid (${dates.length} dates × 7 units) saved to scripts/price-pull.csv`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
