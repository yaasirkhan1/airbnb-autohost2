'use strict';
// DRY-RUN of today's morning check-in sweep against LIVE Hospitable data. Read-only: lists today's
// arrivals, decides who would get instructions, sends NOTHING. Run: node scripts/checkin-sweep-dryrun.js
const fs = require('fs');
const sweep = require('../src/checkin-sweep');
const doorCodes = require('../src/door-codes');
const propsMap = require('../data/properties-map.json');

const TOKEN = (() => {
  try {
    const line = fs.readFileSync(`${__dirname}/../.env`, 'utf8').split('\n').find(l => /^HOSPITABLE_(TOKEN|API_KEY)=/.test(l));
    return line ? line.split('=').slice(1).join('=').trim() : '';
  } catch { return ''; }
})() || process.env.HOSPITABLE_API_KEY || process.env.HOSPITABLE_TOKEN || '';

const B = 'https://public.api.hospitable.com/v2';
const H = { Authorization: `Bearer ${TOKEN}` };
const todayET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const propertyIds = Object.keys(propsMap);

async function listArrivals(day) {
  const out = [];
  for (const pid of propertyIds) {
    const res = await fetch(`${B}/reservations?properties[]=${pid}&include=guest&per_page=50`, { headers: H });
    if (!res.ok) continue;
    const data = await res.json();
    for (const r of (data.data || [])) {
      if ((r.check_in || r.arrival_date || '').slice(0, 10) === day) { r.propertyId = pid; out.push(r); }
    }
  }
  return out;
}
async function fetchThread(id) {
  const res = await fetch(`${B}/reservations/${id}/messages?per_page=50`, { headers: H });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.data || []).map(m => ({ sender_role: m.sender_role || m.sender_type, body: m.body || m.message || '' }));
}

(async () => {
  if (!TOKEN) { console.error('No Hospitable token in .env'); process.exit(1); }
  console.log(`DRY-RUN check-in sweep · ${todayET} (America/New_York) · NO messages sent\n`);
  const r = await sweep.runSweep({
    today: todayET, listArrivals, fetchThread,
    send: async () => {}, smsHost: async () => {},
    propsMap, doorCodeStore: doorCodes.loadStore(), hostName: process.env.HOST_NAME || 'KS', dryRun: true,
  });
  const line = s => `  • ${s.unit || '?'} — ${s.guestName || 'guest'} (res ${s.resId})`;
  console.log(`WOULD SEND (${r.toSend.length}):`); r.toSend.forEach(s => console.log(line(s)));
  console.log(`ALREADY SENT, skip (${r.alreadySent.length}):`); r.alreadySent.forEach(s => console.log(line(s)));
  console.log(`SKIPPED → host alert (${r.skipped.length}):`); r.skipped.forEach(s => console.log(`${line(s)} — missing ${s.missing.join('/')}`));
  console.log(`\nHost SMS that WOULD be sent:\n  ${r.summary}`);
})();
