#!/usr/bin/env node
// Plain-language pricing CLI for the 7 managed Atlanta units.
//
//   node scripts/pricing-cli.js "all 1-bedrooms for Dragon Con Sept 2–6 at $500/night, 5-night min; all 2-bedrooms at $750/night, 5-night min"
//
// DEFAULT = DRY RUN: parses the command, fetches live unit data + current prices from
// Hospitable, prints a PREVIEW (each unit by name, dates, old→new, min-nights, # nights,
// conflicts) and pushes NOTHING. Add --confirm to actually write to Hospitable, and even
// then rows flagged with conflicts are skipped.
//
// Unit→label map: ids/labels are the project's stable mapping (src/managed-properties.js
// / CLAUDE.md); bedroom counts come LIVE from Hospitable capacity.bedrooms (not trusted
// from the label), and the preview re-checks each unit's type against the request.
const fs = require('fs');
const path = require('path');
const { parseCommand, buildPreview, nightDates, bedroomsToType } = require('../src/pricing-command');

const ID_TO_LABEL = {
  'bbe43523-c42a-46b0-8235-7ad08ae990c9': '4-L',
  '1af8fdde-58ee-426e-8374-6530397347e8': '7-B',
  '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc': '18-A',
  '80c21aac-00eb-49af-9094-6792839ff5a4': '21-D',
  '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c': '21-I',
  '283977a3-3af3-4d90-8d95-b418a3014d90': '23-N',
  '3e702102-a219-4c18-9f88-3a4d1ceb3825': '24-L',
};

function token() {
  const line = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
  const t = line ? line.slice('HOSPITABLE_TOKEN='.length).trim() : (process.env.HOSPITABLE_API_KEY || '');
  if (!t) { console.error('No HOSPITABLE_TOKEN in .env / HOSPITABLE_API_KEY in env'); process.exit(1); }
  return t;
}
const TOK = token();
const hosGet = async p => {
  const r = await fetch('https://public.api.hospitable.com/v2' + p, { headers: { Authorization: 'Bearer ' + TOK, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`Hospitable ${r.status} on ${p}`);
  return r.json();
};

async function fetchUnits() {
  const props = (await hosGet('/properties?per_page=50')).data || [];
  const units = [];
  for (const [id, label] of Object.entries(ID_TO_LABEL)) {
    const p = props.find(x => x.id === id);
    units.push({ id, label, bedrooms: p?.capacity?.bedrooms ?? null, name: p?.public_name || p?.name || label });
  }
  return units;
}

// Current nightly price per unit for a date range — read the calendar's first night.
async function fetchCurrentPrices(unitIds, range) {
  const out = {};
  for (const id of unitIds) {
    try {
      const data = await hosGet(`/properties/${id}/calendar?start_date=${range.start}&end_date=${range.end}`);
      const days = data?.data?.days || data?.days || (Array.isArray(data?.data) ? data.data : []);
      const first = days.find(d => d.date === range.start) || days[0];
      out[id] = first?.price?.amount != null ? Math.round(first.price.amount / 100) : (first?.price ?? null);
    } catch { out[id] = null; }
    await new Promise(r => setTimeout(r, 120));
  }
  return out;
}

function renderPreview(rows) {
  const money = v => (v == null ? 'n/a' : `$${v}`);
  for (const r of rows) {
    if (!r.unit) { // clause-level problem
      console.log(`\n  ⛔ CLAUSE: "${r.clause}"`);
      for (const c of r.conflicts) console.log(`     ✗ ${c}`);
      continue;
    }
    const flag = r.conflicts.length ? '⛔' : '✅';
    console.log(`\n  ${flag} ${r.unit} (${r.type}) — ${r.name}`);
    console.log(`     ${r.start} → ${r.end}  (${r.nights} night${r.nights === 1 ? '' : 's'})`);
    console.log(`     price ${money(r.oldPrice)} → ${money(r.newPrice)}   min-nights: ${r.minNights ?? '(unchanged)'}`);
    for (const c of r.conflicts) console.log(`     ✗ ${c}`);
  }
}

async function pushRow(r) {
  // NOTE: verify the calendar min-nights field name against Hospitable's API before real
  // use. Calendar PUT shape mirrors the pricing engine (price.amount in cents).
  const days = nightDates({ start: r.start, end: r.end }).map(date => ({
    date, price: { amount: r.newPrice * 100 }, ...(r.minNights != null ? { min_nights: r.minNights } : {}),
  }));
  const unitId = Object.keys(ID_TO_LABEL).find(id => ID_TO_LABEL[id] === r.unit);
  const res = await fetch(`https://public.api.hospitable.com/v2/properties/${unitId}/calendar`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer ' + TOK, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(days),
  });
  return res.ok ? 'pushed' : `FAILED ${res.status}`;
}

(async () => {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const command = args.filter(a => a !== '--confirm').join(' ').trim();
  if (!command) { console.error('Usage: node scripts/pricing-cli.js "<command>" [--confirm]'); process.exit(1); }

  console.log(`COMMAND: ${command}\n`);
  const clauses = parseCommand(command);
  const units = await fetchUnits();

  // current prices only for the date ranges that appear
  const ranges = [...new Set(clauses.filter(c => c.dateRange).map(c => JSON.stringify(c.dateRange)))].map(s => JSON.parse(s));
  const priceByUnit = {};
  for (const range of ranges) Object.assign(priceByUnit, await fetchCurrentPrices(units.map(u => u.id), range));

  const { rows, hasConflicts } = buildPreview(clauses, units, priceByUnit);
  console.log('================= PREVIEW =================');
  renderPreview(rows);

  const writable = rows.filter(r => r.unit && !r.blocked);
  const blocked = rows.filter(r => r.blocked);
  console.log('\n==========================================');
  console.log(`${writable.length} unit-write(s) ready, ${blocked.length} blocked by conflicts.`);

  if (!confirm) {
    console.log('\nDRY RUN — nothing pushed to Hospitable. Re-run with --confirm to push (blocked rows are always skipped).');
    process.exit(hasConflicts ? 2 : 0);
  }

  if (!writable.length) { console.log('Nothing to push.'); process.exit(2); }
  console.log('\n--confirm given — pushing the non-conflicting rows:');
  for (const r of writable) console.log(`  ${r.unit}: ${await pushRow(r)}`);
})().catch(e => { console.error('pricing-cli error:', e.message); process.exit(1); });
