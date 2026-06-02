#!/usr/bin/env node
/**
 * set-pricing.js — calendar-driven pricing CLI for the 7 Peachtree units.
 *
 * Reads config/pricing-calendar.json (tier grid + event overrides + countdown
 * rules + rails) and produces a per-date price/min-stay plan for a unit and date
 * range. DRY-RUN by default; only writes to Hospitable with --commit.
 *
 * SAFETY RAILS (all enforced here):
 *   - Blackout: never modify dates in calendar.blackout (World Cup). Absolute.
 *   - Floor $75 / Ceiling $700: a target outside this ABORTS the whole run. Absolute.
 *   - Weekend floor: Fri/Sat never below the unit-group's weekend tier ($99+). Absolute.
 *   - Tool-owned ledger + claim-on-first-write: the tool only updates dates it set;
 *     if you hand-edit a date in Hospitable, it's permanently released (manual wins).
 *   - Manual override file (config/pricing-overrides.json) takes priority over tier
 *     logic, but is still bound by blackout + floor/ceiling (both absolute).
 *
 * Assumption baked in (per the calendar's countdown table): the tool only prices
 * OPEN (unbooked) nights — booked nights are skipped — so as a date approaches and
 * is still open, it is treated as "behind" and stepped down toward the floor.
 *
 * Usage:
 *   node scripts/set-pricing.js --unit 21-D --from 2026-08-01 --to 2026-08-14 [--commit]
 *   node scripts/set-pricing.js --all --from 2026-08-01 --to 2026-11-30
 *   node scripts/set-pricing.js --unit <uuid> --group older_1br --from .. --to ..   (force group)
 *   Flags: --calendar <path> --overrides <path> --today YYYY-MM-DD --horizon N --json
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE = 'https://public.api.hospitable.com/v2';

// 7 live units → nickname/id, and the demand calendar's group keys.
const LIVE_UNITS = {
  '4-L':  'bbe43523-c42a-46b0-8235-7ad08ae990c9',
  '7-B':  '1af8fdde-58ee-426e-8374-6530397347e8',
  '18-A': '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',
  '21-D': '80c21aac-00eb-49af-9094-6792839ff5a4',
  '21-I': '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c',
  '23-N': '283977a3-3af3-4d90-8d95-b418a3014d90',
  '24-L': '3e702102-a219-4c18-9f88-3a4d1ceb3825',
};

// ── small date helpers (all date-only, parsed as UTC to avoid TZ drift) ──────
const asDate = s => new Date(s + 'T00:00:00Z');
const ymd = d => d.toISOString().slice(0, 10);
const isWeekend = s => [5, 6].includes(asDate(s).getUTCDay()); // Fri or Sat night
const daysBetween = (a, b) => Math.round((asDate(b) - asDate(a)) / 86400000);
const { dateInTimeZone } = require('../src/cleaning-schedule');
// "Today" as the Atlanta (America/New_York) calendar date — correct on evening
// runs too (plain UTC rolls a day ahead after ~8pm ET, throwing off days-out).
const todayET = (now = new Date()) => dateInTimeZone(now, 'America/New_York');
function dateRange(from, to) {
  const out = []; let d = asDate(from);
  const end = asDate(to);
  while (d <= end) { out.push(ymd(d)); d = new Date(d.getTime() + 86400000); }
  return out;
}

// ── calendar lookups (pure) ──────────────────────────────────────────────────
function groupForUnit(nick, cal, forced) {
  if (forced) return forced;
  for (const [g, list] of Object.entries(cal.unit_groups)) if (list.includes(nick)) return g;
  return null;
}
function findEvent(date, cal) {
  // Highest-priority event covering this date: override > high_push > high > others.
  // Events with null dates (unconfirmed) and "covered_by_*" rules are ignored
  // (the covering override event matches on its own range).
  const covering = cal.events.filter(e =>
    e.start && e.end && date >= e.start && date <= e.end && e.rule !== 'covered_by_dragon_con');
  if (!covering.length) return null;
  const rank = e => e.rule.startsWith('override:') ? 3 : e.rule === 'high_push' ? 2 : e.rule.startsWith('high') ? 1 : 0;
  return covering.sort((a, b) => rank(b) - rank(a))[0];
}

const TIER_LADDER = ['emergency_fill', 'low', 'normal', 'weekend', 'high'];

// Normal (non-event) countdown for an OPEN night: step the base tier toward the
// floor as the date approaches. Weekend floor is reclamped afterward.
function normalCountdownTier(baseTier, daysOut) {
  const i = TIER_LADDER.indexOf(baseTier);
  if (daysOut <= 14) return 'emergency_fill';
  if (daysOut <= 21) return TIER_LADDER[Math.max(0, i - 2)];
  if (daysOut <= 30) return TIER_LADDER[Math.max(0, i - 1)];
  return baseTier; // >=31: hold
}
// Compression (event) countdown for a high-tier event: hold until ~14 days out.
function compressionCountdownTier(daysOut) {
  if (daysOut >= 15) return 'high';
  if (daysOut >= 8)  return 'weekend';
  return 'normal';
}

/**
 * computeTarget — PURE decision for one (date, unit-group). Returns:
 *   { action: 'set'|'skip'|'abort', reason, price?, min_stay?, source? }
 * `live` = current Hospitable day {price, min_stay, available} (or null in tests).
 */
function computeTarget({ date, group, today, cal, overrides }) {
  const rails = cal.rails;
  const weekend = isWeekend(date);
  const daysOut = daysBetween(today, date);

  // 1. Blackout — absolute, never modify.
  if (date >= cal.blackout.start && date <= cal.blackout.end)
    return { action: 'skip', reason: 'blackout (World Cup — never modify)' };
  // 2. Outside the strategy window.
  if (date < cal.window.start || date > cal.window.end)
    return { action: 'skip', reason: 'outside calendar window' };

  let price, minStay, source;

  // 3. Manual override file (rule #4) — priority over tier logic, but rails absolute.
  const ov = overrides && overrides[date];
  if (ov && ov.price != null) {
    if (ov.price < rails.floor || ov.price > rails.ceiling)
      return { action: 'abort', reason: `override $${ov.price} on ${date} violates rails $${rails.floor}–$${rails.ceiling}` };
    price = ov.price;
    minStay = ov.min_stay != null ? ov.min_stay : (weekend ? 2 : 1);
    source = 'manual-override-file';
  } else {
    const ev = findEvent(date, cal);
    if (ev && ev.rule.startsWith('override:')) {
      const key = ev.rule.split(':')[1];
      const o = cal.event_overrides[key];
      if (daysOut >= 15) { price = o[group]; minStay = o.min_stay; }          // hold firm
      else if (daysOut >= 8) { price = cal.tiers.high[group]; minStay = Math.max(2, o.min_stay - 1); }
      else if (daysOut >= 4) { price = cal.tiers.high[group]; minStay = 2; }
      else { price = cal.tiers.normal[group]; minStay = 1; }                  // emergency
      source = `event-override:${key}${daysOut >= 15 ? '' : ' (countdown-trimmed)'}`;
    } else {
      // base tier from event rule or weekday/weekend
      let tier;
      if (ev && (ev.rule === 'high' || ev.rule === 'high_push' || ev.rule === 'high_single')) tier = 'high';
      else if (ev && ev.rule === 'floor') tier = 'emergency_fill';
      else if (ev && ev.rule === 'weekend') tier = 'weekend';
      else tier = weekend ? 'weekend' : 'normal';

      // countdown for OPEN nights
      tier = ev ? compressionCountdownTier(daysOut) === 'high' && tier === 'high' ? 'high'
                  : (tier === 'high' ? compressionCountdownTier(daysOut) : tier)
                : normalCountdownTier(tier, daysOut);

      price = cal.tiers[tier][group];
      minStay = ev && ev.min_stay != null ? ev.min_stay : (cal.min_stay_by_tier[tier] != null ? cal.min_stay_by_tier[tier] : (weekend ? 2 : 1));
      source = ev ? `event:${ev.name}→${tier}` : `base:${tier}`;
    }
  }

  // 4. Rails (absolute), applied in order:
  if (weekend) price = Math.max(price, cal.tiers.weekend[group]); // weekend floor (scaled per group)
  price = Math.max(price, rails.floor);                           // hard floor $75
  if (price > rails.ceiling)
    return { action: 'abort', reason: `computed $${price} on ${date} exceeds ceiling $${rails.ceiling}` };
  if (price < rails.floor)
    return { action: 'abort', reason: `computed $${price} on ${date} below floor $${rails.floor}` };

  return { action: 'set', price, min_stay: minStay, source };
}

// ── I/O (impure) ─────────────────────────────────────────────────────────────
function loadToken() {
  const KEY = 'HOSPITABLE_TOKEN=';
  const line = fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n').find(l => l.startsWith(KEY));
  if (!line) throw new Error('HOSPITABLE_TOKEN missing from .env');
  return line.slice(KEY.length).trim();
}
function loadJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function saveJSON(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p); // atomic
}
async function fetchCalendar(id, from, to, token) {
  const url = `${BASE}/properties/${id}/calendar?start_date=${from}&end_date=${to}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  if (!res.ok) throw new Error(`calendar GET ${id} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const days = (await res.json()).data?.days || [];
  const map = {};
  for (const d of days) {
    map[d.date] = {
      price: d.price?.amount != null ? d.price.amount / 100 : null,
      min_stay: d.min_stay,
      available: d.status?.available !== false,
    };
  }
  return map;
}
async function pushDays(id, days, token) {
  // days: [{date, price: dollars, min_stay}]
  const body = days.map(d => ({ date: d.date, price: { amount: Math.round(d.price * 100) }, min_stay: d.min_stay }));
  const res = await fetch(`${BASE}/properties/${id}/calendar`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`calendar PUT ${id} ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return true;
}

function parseArgs(argv) {
  const a = { commit: false, json: false, horizon: 120 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--commit') a.commit = true;
    else if (k === '--json') a.json = true;
    else if (k === '--all') a.all = true;
    else if (k.startsWith('--')) a[k.slice(2)] = argv[++i];
  }
  return a;
}

const LEDGER_PATH = path.join(ROOT, 'data', 'pricing-ledger.json');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cal = loadJSON(path.join(ROOT, args.calendar || 'config/pricing-calendar.json'));
  if (!cal) { console.error('Could not load pricing calendar.'); process.exit(1); }
  const overridesAll = loadJSON(path.join(ROOT, args.overrides || 'config/pricing-overrides.json'), {});
  const ledger = loadJSON(LEDGER_PATH, {});
  const token = loadToken();
  const today = args.today || todayET();

  const from = args.from || today;
  const to = args.to || ymd(new Date(asDate(today).getTime() + (args.horizon * 86400000)));

  const targets = args.all ? Object.keys(LIVE_UNITS)
    : [args.unit];
  if (!targets[0]) { console.error('Provide --unit <nickname|id> or --all'); process.exit(1); }

  console.log(`\n${args.commit ? '🔴 COMMIT' : '🟢 DRY-RUN'} | today=${today} | range ${from} → ${to}`);
  console.log(`rails: floor $${cal.rails.floor} · weekend $${cal.rails.weekend_floor}+ · ceiling $${cal.rails.ceiling} · blackout ${cal.blackout.start}..${cal.blackout.end}\n`);

  let abortViolations = [];

  for (const u of targets) {
    const id = LIVE_UNITS[u] || u;                       // nickname or raw id
    const nick = LIVE_UNITS[u] ? u : (args.unit_nick || u);
    const group = groupForUnit(nick, cal, args.group);
    if (!group) {
      console.log(`UNIT ${u}: no calendar group (use --group older_1br|updated_1br|premium_1br|twobr). Skipping.\n`);
      continue;
    }
    const live = await fetchCalendar(id, from, to, token);
    const overrides = overridesAll[nick] || overridesAll[id] || {};
    ledger[id] = ledger[id] || { managed: {}, released: [] };
    const L = ledger[id];

    const rows = [];
    const writes = [];
    for (const date of dateRange(from, to)) {
      const cur = live[date] || { price: null, min_stay: null, available: true };

      // booked → skip
      if (cur.available === false) { rows.push({ date, cur, action: 'skip', reason: 'booked/blocked' }); continue; }
      // released tombstone → skip (manual wins, permanent)
      if (L.released.includes(date)) { rows.push({ date, cur, action: 'skip', reason: 'manual (released)' }); continue; }
      // divergence: managed but hand-edited → release permanently
      if (L.managed[date]) {
        const m = L.managed[date];
        if (cur.price !== m.price || cur.min_stay !== m.min_stay) {
          L.released.push(date); delete L.managed[date];
          rows.push({ date, cur, action: 'skip', reason: 'manual edit detected → released permanently' });
          continue;
        }
      }
      // eligible (managed-and-unchanged, or first-touch claim)
      const t = computeTarget({ date, group, today, cal, overrides });
      if (t.action === 'abort') { abortViolations.push(`${nick} ${date}: ${t.reason}`); rows.push({ date, cur, action: 'abort', reason: t.reason }); continue; }
      if (t.action === 'skip') { rows.push({ date, cur, action: 'skip', reason: t.reason }); continue; }
      const noChange = cur.price === t.price && cur.min_stay === t.min_stay;
      rows.push({ date, cur, action: noChange ? 'nochange' : 'set', reason: t.source, price: t.price, min_stay: t.min_stay });
      if (!noChange) writes.push({ date, price: t.price, min_stay: t.min_stay });
    }

    // print plan for this unit
    printPlan(nick, group, rows);

    // commit (only if no rail violations anywhere)
    if (args.commit && writes.length && abortViolations.length === 0) {
      await pushDays(id, writes, token);
      const now = new Date().toISOString();
      for (const w of writes) L.managed[w.date] = { price: w.price, min_stay: w.min_stay, setAt: now };
      console.log(`  ✍️  committed ${writes.length} writes to ${nick} and updated ledger`);
    }
  }

  if (abortViolations.length) {
    console.log(`\n⛔ ABORT — ${abortViolations.length} rail violation(s); NOTHING was written:`);
    abortViolations.forEach(v => console.log('   • ' + v));
    process.exit(2);
  }
  if (args.commit) saveJSON(LEDGER_PATH, ledger);
  else console.log('\n(dry-run — no writes, ledger untouched. Add --commit to apply.)');
}

function printPlan(nick, group, rows) {
  console.log(`══ ${nick}  (group: ${group}) ══`);
  const f = (v, w) => String(v ?? '').padEnd(w);
  console.log(`${f('DATE', 11)}${f('DOW', 4)}${f('CUR $/min', 12)}${f('→ NEW $/min', 13)}${f('ACTION', 9)}REASON`);
  for (const r of rows) {
    const dow = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][asDate(r.date).getUTCDay()];
    const cur = `${r.cur.price ?? '—'}/${r.cur.min_stay ?? '—'}`;
    const nw = r.action === 'set' ? `${r.price}/${r.min_stay}` : (r.action === 'nochange' ? '(same)' : '—');
    const mark = { set: '✦ SET', nochange: '· keep', skip: '· skip', abort: '⛔ ABORT' }[r.action];
    console.log(`${f(r.date, 11)}${f(dow, 4)}${f(cur, 12)}${f(nw, 13)}${f(mark, 9)}${r.reason}`);
  }
  const n = rows.filter(r => r.action === 'set').length;
  console.log(`   → ${n} change(s), ${rows.filter(r => r.action === 'skip').length} skipped, ${rows.filter(r => r.action === 'nochange').length} unchanged\n`);
}

module.exports = { computeTarget, isWeekend, findEvent, normalCountdownTier, compressionCountdownTier, dateRange, groupForUnit, todayET, daysBetween };

if (require.main === module) {
  main().catch(e => { console.error('ERROR:', e.message); process.exit(1); });
}
