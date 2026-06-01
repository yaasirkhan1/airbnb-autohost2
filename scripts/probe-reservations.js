// READ-ONLY: inspect the reservation object schema (esp. financial/rate fields)
// so we can compute ADR / RevPAR / occupancy. No writes.
const fs = require('fs');
const path = require('path');
const KEY = 'HOSPITABLE_TOKEN=';
const tok = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n').find(l => l.startsWith(KEY)).slice(KEY.length).trim();
const BASE = 'https://public.api.hospitable.com/v2';
const PROP = '80c21aac-00eb-49af-9094-6792839ff5a4'; // 21-D

async function tryGet(url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
  const txt = await res.text();
  return { status: res.status, ok: res.ok, body: txt };
}

(async () => {
  // Try a few include combos to discover financial fields
  const candidates = [
    `${BASE}/reservations?properties[]=${PROP}&per_page=3&include=guest,financials`,
    `${BASE}/reservations?properties[]=${PROP}&per_page=3&include=financials`,
    `${BASE}/reservations?properties[]=${PROP}&per_page=3`,
  ];
  for (const url of candidates) {
    const r = await tryGet(url);
    console.log(`\n=== ${url.replace(BASE,'')} → ${r.status} ===`);
    if (!r.ok) { console.log(r.body.slice(0, 200)); continue; }
    const j = JSON.parse(r.body);
    console.log('top-level keys:', Object.keys(j));
    console.log('result count:', (j.data || []).length, '| meta:', JSON.stringify(j.meta || {}).slice(0,200));
    const first = (j.data || [])[0];
    if (first) {
      console.log('reservation keys:', Object.keys(first));
      console.log('FULL first reservation:\n', JSON.stringify(first, null, 2).slice(0, 2500));
    }
    break; // first successful combo is enough
  }
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
