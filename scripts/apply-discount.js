#!/usr/bin/env node
/**
 * apply-discount.js — idempotent, base-anchored percentage discount for the Atlanta units.
 *
 * Replaces the ad-hoc "read the LIVE price, multiply by 0.9, write it back" one-liner that
 * compounds every run (the bug that drove 23-N's June 14 to $3.60). Here the discount is
 * ALWAYS computed from a STORED BASE price, never from the live price:
 *
 *   - First time a (unit, date) is discounted, its current live price is snapshotted into
 *     data/pricing-base.json. That snapshot is the base and is NEVER overwritten by this tool
 *     (claim-on-first-write, like set-pricing's ledger). Re-running reads the same base, so the
 *     result is identical — no stacking, no matter how many times you run it.
 *   - Discounted = round(base * (1 - pct/100)), then clamped UP to the unit floor
 *     ($175 1BR / $250 2BR). A discount can never push a sub-floor price.
 *
 * DRY-RUN by default; only writes to Hospitable with --commit.
 *
 * Usage:
 *   node scripts/apply-discount.js --pct 10 --from 2026-06-07 --to 2026-06-14            (all units, dry-run)
 *   node scripts/apply-discount.js --pct 10 --from 2026-06-07 --to 2026-06-14 --commit   (write)
 *   node scripts/apply-discount.js --unit 23-N --pct 10 --from .. --to ..                (one unit)
 *   node scripts/apply-discount.js --reset-base --unit 23-N --from .. --to ..            (forget stored base)
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = 'https://public.api.hospitable.com/v2';
const BASE_SNAPSHOT_PATH = path.join(ROOT, 'data', 'pricing-base.json');

// 7 live units → id (same mapping set-pricing.js uses).
const LIVE_UNITS = {
  '4-L':  'bbe43523-c42a-46b0-8235-7ad08ae990c9',
  '7-B':  '1af8fdde-58ee-426e-8374-6530397347e8',
  '18-A': '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',
  '21-D': '80c21aac-00eb-49af-9094-6792839ff5a4',
  '21-I': '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', // 2BR
  '23-N': '283977a3-3af3-4d90-8d95-b418a3014d90',
  '24-L': '3e702102-a219-4c18-9f88-3a4d1ceb3825',
};
const TWO_BR_ID = LIVE_UNITS['21-I'];
const floorFor = id => (id === TWO_BR_ID ? 250 : 175); // same floors as PRICE_RULES / the hourly engine

// ── pure core (unit-tested) ────────────────────────────────────────────────────
// The discount ALWAYS derives from `base`, never from a live/previous price — so it is
// idempotent: discountedFromBase(discountedFromBase(b)) === discountedFromBase(b).
function discountedFromBase(base, pct, floor) {
  if (typeof base !== 'number' || !isFinite(base)) return null;
  return Math.max(Math.round(base * (1 - pct / 100)), floor);
}

// ── date helpers (UTC, date-only) ──────────────────────────────────────────────
const asDate = s => new Date(s + 'T00:00:00Z');
const ymd = d => d.toISOString().slice(0, 10);
function dateRange(from, to) {
  const out = []; let d = asDate(from); const end = asDate(to);
  while (d <= end) { out.push(ymd(d)); d = new Date(d.getTime() + 86400000); }
  return out;
}

// ── I/O ─────────────────────────────────────────────────────────────────────────
function loadJSON(p, fallback) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function saveJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p); // atomic
}
function loadToken() {
  const KEY = 'HOSPITABLE_TOKEN=';
  const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').find(l => l.startsWith(KEY));
  if (!line) throw new Error('HOSPITABLE_TOKEN missing from .env');
  return line.slice(KEY.length).trim();
}
async function fetchCalendar(id, from, to, token) {
  const url = `${BASE_URL}/properties/${id}/calendar?start_date=${from}&end_date=${to}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`calendar GET ${id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const days = (await res.json()).data?.days || [];
  const map = {};
  for (const d of days) map[d.date] = d.price?.amount != null ? d.price.amount / 100 : null;
  return map;
}
async function pushDays(id, days, token) {
  const body = days.map(d => ({ date: d.date, price: { amount: Math.round(d.price * 100) }, min_stay: 1 }));
  const res = await fetch(`${BASE_URL}/properties/${id}/calendar`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`calendar PUT ${id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

function parseArgs(argv) {
  const a = { commit: false, resetBase: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--commit') a.commit = true;
    else if (k === '--all') a.all = true;
    else if (k === '--reset-base') a.resetBase = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const pct = Number(args.pct);
  if (!isFinite(pct) || pct <= 0 || pct >= 100) { console.error('Provide --pct <1-99>'); process.exit(1); }
  if (!args.from || !args.to) { console.error('Provide --from YYYY-MM-DD --to YYYY-MM-DD'); process.exit(1); }

  const token = loadToken();
  const snapshot = loadJSON(BASE_SNAPSHOT_PATH, {}); // { [id]: { [date]: basePriceUSD } }
  const units = args.all ? Object.keys(LIVE_UNITS) : (args.unit ? [args.unit] : Object.keys(LIVE_UNITS));
  const dates = dateRange(args.from, args.to);

  console.log(`\n${args.commit ? '🔴 COMMIT' : '🟢 DRY-RUN'} | -${pct}% off STORED BASE | ${args.from} → ${args.to}`);

  for (const u of units) {
    const id = LIVE_UNITS[u] || u;
    const floor = floorFor(id);
    snapshot[id] = snapshot[id] || {};
    const baseMap = snapshot[id];

    if (args.resetBase) { for (const d of dates) delete baseMap[d]; console.log(`  ${u}: base forgotten for ${dates.length} dates`); continue; }

    const live = await fetchCalendar(id, args.from, args.to, token);
    const writes = [];
    console.log(`══ ${u} (floor $${floor}) ══`);
    for (const date of dates) {
      // claim-on-first-write: snapshot the live price as base ONCE; never overwrite it here.
      if (baseMap[date] == null && live[date] != null) baseMap[date] = live[date];
      const base = baseMap[date];
      if (base == null) { console.log(`   ${date}  (no base / no live price — skip)`); continue; }
      const target = discountedFromBase(base, pct, floor);
      const clamped = target === floor && Math.round(base * (1 - pct / 100)) < floor ? ' [floored]' : '';
      const same = live[date] === target;
      console.log(`   ${date}  base $${base} → $${target}${clamped}${same ? '  (already set)' : ''}`);
      if (!same) writes.push({ date, price: target });
    }

    if (args.commit && writes.length) {
      await pushDays(id, writes, token);
      console.log(`   ✍️  committed ${writes.length} day(s) to ${u}`);
    }
  }

  // Persist the base snapshot (claims made this run) unless we were only previewing a reset.
  if (args.commit || !args.resetBase) saveJSON(BASE_SNAPSHOT_PATH, snapshot);
  if (!args.commit) console.log('\n(dry-run — no prices written. Base snapshot updated with any first-seen prices. Add --commit to apply.)');
}

module.exports = { discountedFromBase, floorFor, dateRange };

if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
