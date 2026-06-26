// READ-ONLY dry-run of tomorrow's opportunity digest. Live Hospitable GETs only — NO sends, NO writes.
// Mirrors runOpportunityScan() but standalone. Run: node scripts/opportunity-digest-dryrun.js
const fs = require('fs'), path = require('path');
const S = require('../src/opportunity-scanner');

const KEY = 'HOSPITABLE_TOKEN=';
const tok = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').find(l => l.startsWith(KEY)).slice(KEY.length).trim();
const BASE = 'https://public.api.hospitable.com/v2';
const UNITS = [
  ['4-L', 'bbe43523-c42a-46b0-8235-7ad08ae990c9'], ['7-B', '1af8fdde-58ee-426e-8374-6530397347e8'],
  ['18-A', '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc'], ['21-D', '80c21aac-00eb-49af-9094-6792839ff5a4'],
  ['21-I', '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c'], ['23-N', '283977a3-3af3-4d90-8d95-b418a3014d90'],
  ['24-L', '3e702102-a219-4c18-9f88-3a4d1ceb3825'],
];
const ACTIVE = new Set(['accepted', 'checked_in', 'checked_out', 'confirmed']);
const TODAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

const get = async (u) => { const r = await fetch(u, { headers: { Authorization: `Bearer ${tok}` } }); if (!r.ok) throw new Error(`${r.status}`); return r.json(); };
const co = r => (r.check_out || r.checkout || r.departure_date || r.end_date || '').slice(0, 10);
const ci = r => (r.check_in || r.checkin || r.arrival_date || r.start_date || '').slice(0, 10);

(async () => {
  const end = S.addDays(TODAY, 10);
  console.log(`DRY-RUN (no sends) — ET today ${TODAY}, scanning through ${end}\n`);
  const snaps = [];
  for (const [label, id] of UNITS) {
    const rData = await get(`${BASE}/reservations?properties[]=${id}&start_date=${S.addDays(TODAY, -2)}&end_date=${end}&per_page=100&include=guest`);
    const reservations = (rData.data || []).filter(r => { const st = (r.status || r.reservation_status || '').toLowerCase(); return !st || ACTIVE.has(st); })
      .map(r => ({ id: r.id, guest: r.guest && (r.guest.full_name || r.guest.first_name), firstName: ((r.guest && (r.guest.full_name || r.guest.first_name)) || '').split(/\s+/)[0], checkIn: ci(r), checkOut: co(r) }));
    const cData = await get(`${BASE}/properties/${id}/calendar?start_date=${TODAY}&end_date=${end}`);
    const calendar = {};
    for (const d of (cData.data?.days || [])) calendar[d.date] = { available: !!(d.status && d.status.available === true), price: d.price && d.price.amount != null ? Math.round(d.price.amount / 100) : null };
    snaps.push({ unit: label, propertyId: id, today: TODAY, tomorrow: S.addDays(TODAY, 1), reservations, calendar });
    await new Promise(r => setTimeout(r, 150));
  }
  const vacantCount = snaps.filter(u => S.nightVacant(u, u.tomorrow)).length;
  const items = S.buildDigestItems(snaps.flatMap(u => S.scanUnit(u)), { vacantCount });
  console.log(`(vacancy that night: ${vacantCount} units → extension markup +$${require('../src/extension-offer').scaleMarkup(vacantCount)})\n`);
  console.log(S.formatDigest(items, S.addDays(TODAY, 1)));
  console.log('\n(read-only — nothing sent)');
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
