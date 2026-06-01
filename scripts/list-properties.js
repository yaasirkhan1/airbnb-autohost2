// READ-ONLY: lists all Hospitable properties (id + name/nickname). No writes.
// Reads HOSPITABLE_TOKEN from .env. Run: node scripts/list-properties.js
const fs = require('fs');
const path = require('path');

function loadToken() {
  const envPath = path.join(__dirname, '..', '.env');
  const line = fs.readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
  const tok = line ? line.slice('HOSPITABLE_TOKEN='.length).trim() : '';
  if (!tok) { console.error('HOSPITABLE_TOKEN missing from .env'); process.exit(1); }
  return tok;
}

const BASE = 'https://public.api.hospitable.com/v2';

async function getJson(url, token) {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

(async () => {
  const token = loadToken();
  let url = `${BASE}/properties?per_page=100`;
  const all = [];
  // Follow pagination if present
  while (url) {
    const body = await getJson(url, token);
    (body.data || []).forEach(p => all.push(p));
    url = body.links && body.links.next ? body.links.next : null;
  }

  // Sort by name for readability
  all.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));

  const rows = all.map(p => ({
    id: p.id,
    name: p.name || '',
    public_name: p.public_name || '',
    nickname: p.private_name || p.nickname || '',
    status: (p.listed === false ? 'unlisted' : (p.status || '')),
    city: p.address?.city || p.city || '',
  }));

  console.log(`\nTotal properties: ${all.length}\n`);
  // Print as an aligned table
  const cols = ['id', 'nickname', 'name', 'public_name', 'status'];
  const widths = {};
  cols.forEach(c => { widths[c] = Math.max(c.length, ...rows.map(r => String(r[c] ?? '').length)); });
  const fmt = r => cols.map(c => String(r[c] ?? '').padEnd(widths[c])).join('  ');
  console.log(fmt(Object.fromEntries(cols.map(c => [c, c.toUpperCase()]))));
  console.log(cols.map(c => '-'.repeat(widths[c])).join('  '));
  rows.forEach(r => console.log(fmt(r)));

  // Also emit machine-readable JSON for downstream tooling
  fs.writeFileSync(path.join(__dirname, 'properties-list.json'), JSON.stringify(rows, null, 2));
  console.log(`\nWrote scripts/properties-list.json (${rows.length} entries)`);
})().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
