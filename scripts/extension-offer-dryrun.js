// READ-ONLY dry-run of the 7 PM vacant-night extension-offer sweep. Live Hospitable GETs only —
// NO sends, NO writes. Mirrors runExtensionOfferSweep(dryRun=true) in server.js but standalone, so
// it can be run by hand to preview tomorrow's eligible offers.  Run: node scripts/extension-offer-dryrun.js
const fs = require('fs'), path = require('path');
const x = require('../src/extension-offer');

const KEY = 'HOSPITABLE_TOKEN=';
const tok = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8')
  .split('\n').find(l => l.startsWith(KEY)).slice(KEY.length).trim();
const BASE = 'https://public.api.hospitable.com/v2';

const UNITS = [
  { id: '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc', label: 'Apt 18-A' },
  { id: '80c21aac-00eb-49af-9094-6792839ff5a4', label: 'Apt 21-D' },
  { id: '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', label: 'Apt 21-I' },
  { id: '3e702102-a219-4c18-9f88-3a4d1ceb3825', label: 'Apt 24-L' },
  { id: 'bbe43523-c42a-46b0-8235-7ad08ae990c9', label: 'Apt 4-L'  },
  { id: '283977a3-3af3-4d90-8d95-b418a3014d90', label: 'Apt 23-N' },
  { id: '1af8fdde-58ee-426e-8374-6530397347e8', label: 'Apt 7-B'  },
];
const ACTIVE = new Set(['accepted', 'checked_in', 'checked_out', 'confirmed']);

const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const addDays = (s, n) => { const d = new Date(s + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TOMORROW = addDays(etToday, 1);

const get = async (url) => {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' } });
  if (!r.ok) throw new Error(`${r.status} ${(await r.text()).slice(0, 120)}`);
  return r.json();
};
const co = r => (r.check_out || r.checkout || r.check_out_date || r.departure_date || r.end_date || '').slice(0, 10);
const ci = r => (r.check_in || r.checkin || r.check_in_date || r.arrival_date || r.start_date || '').slice(0, 10);
const active = r => { const s = (r.status || r.reservation_status || '').toLowerCase(); return !s || ACTIVE.has(s); };

(async () => {
  console.log(`DRY-RUN (no sends) — ET today ${etToday} → checkout TOMORROW ${TOMORROW}\n`);
  const rows = [];
  for (const u of UNITS) {
    const rData = await get(`${BASE}/reservations?properties[]=${u.id}&start_date=${addDays(TOMORROW, -30)}&end_date=${addDays(TOMORROW, 1)}&per_page=100&include=guest`);
    const res = (rData.data || []).filter(active);
    const outgoing = res.filter(r => co(r) === TOMORROW);
    const incoming = res.filter(r => ci(r) === TOMORROW);
    const cData = await get(`${BASE}/properties/${u.id}/calendar?start_date=${TOMORROW}&end_date=${TOMORROW}`);
    const day = (cData.data?.days || []).find(d => d.date === TOMORROW);
    const available = !!(day && day.status && day.status.available === true);
    const price = day && day.price && day.price.amount != null ? Math.round(day.price.amount / 100) : null;
    rows.push({ u, outgoing, incoming, available, price });
    await new Promise(r => setTimeout(r, 150));
  }

  const vacantCount = rows.filter(r => r.available).length;
  console.log('--- all units on the checkout night ---');
  for (const r of rows)
    console.log(`${r.u.label.padEnd(9)} checkout-tom=${r.outgoing.length ? 'Y' : 'n'} sameDayTurn=${r.incoming.length ? 'Y' : 'n'} vacant=${r.available ? 'Y' : 'n'} price=${r.price == null ? '-' : '$' + r.price}`);
  console.log(`\nUnits vacant that night: ${vacantCount} → markup +$${x.scaleMarkup(vacantCount)}\n`);

  const eligible = rows.filter(r => x.isEligible(r) && r.available && r.price != null);
  console.log(`=== ELIGIBLE OFFERS: ${eligible.length} (NOTHING SENT) ===\n`);
  for (const r of eligible) {
    const guest = x.defaultNameOf(r.outgoing[0]);
    const first = x.firstToken(guest);
    const price = x.computeQuote(r.price, vacantCount);
    console.log(`• ${r.u.label} — ${guest} — calendar $${r.price} + $${x.scaleMarkup(vacantCount)} = $${price}`);
    console.log('  ┌─ message ─────────────────────────────────────────────');
    console.log(x.renderOffer(first, price).split('\n').map(l => '  │ ' + l).join('\n'));
    console.log('  └───────────────────────────────────────────────────────\n');
  }
  if (!eligible.length) console.log('(no eligible offers for tomorrow)');
})().catch(e => { console.error('ERROR', e.message); process.exit(1); });
