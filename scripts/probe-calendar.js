// READ-ONLY: dumps raw Hospitable calendar day objects so we can see which
// fields indicate a manual/custom price, min-stay, availability, etc.
// No writes. Run: node scripts/probe-calendar.js
const fs = require('fs');
const path = require('path');
const tok = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN=')).slice('HOSPITABLE_TOKEN='.length).trim();

const BASE = 'https://public.api.hospitable.com/v2';
const PROP = '80c21aac-00eb-49af-9094-6792839ff5a4'; // 21-D (read-only inspection)

(async () => {
  // Span a normal week (early June) and a World Cup blackout week (mid June/July)
  const url = `${BASE}/properties/${PROP}/calendar?start_date=2026-06-05&end_date=2026-06-20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
  if (!res.ok) { console.error(res.status, await res.text()); process.exit(1); }
  const body = await res.json();
  const days = body.data?.days || body.days || [];
  console.log('Top-level keys:', Object.keys(body.data || body));
  console.log('Day count:', days.length);
  if (days[0]) console.log('\nFull field set of one day object:\n', JSON.stringify(days[0], null, 2));
  console.log('\nPer-day summary (date | price | min_stay | available | status):');
  for (const d of days) {
    console.log(`  ${d.date} | ${JSON.stringify(d.price)} | min_stay=${d.min_stay} | avail=${d.available ?? d.status?.available} | status=${JSON.stringify(d.status)}`);
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
