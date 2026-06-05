// Proves a SIMULATED push-failure through the real runner triggers a REAL alert send.
// global.fetch is mocked (no network): Hospitable PUT → 500 (forces retry-exhausted), and the
// OpenPhone POST is captured. Run: node scripts/test-alert-pushfail.js
'use strict';
const assert = require('assert');
const fs = require('fs');

process.env.HOSPITABLE_API_KEY = 'mock';
process.env.QUO_API_KEY = 'key-123';
process.env.QUO_FROM_NUMBER = '+15550000001';
process.env.NOTIFY_PHONE = '+15559999999';
process.env.PRICING_DATA_DIR = '/tmp/alert-pushfail-data';
fs.rmSync(process.env.PRICING_DATA_DIR, { recursive: true, force: true });

const sent = []; // captured OpenPhone SMS payloads
const mk = (status, obj) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(obj) });
const daysInclusive = (s, e) => { const out = []; let d = new Date(s + 'T00:00:00Z'); const end = new Date(e + 'T00:00:00Z'); for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(d.toISOString().slice(0, 10)); return out; };
const calOf = (dates) => ({ data: { days: dates.map(date => ({ date, price: { amount: 10000, currency: 'USD' }, status: { available: true, reason: 'AVAILABLE' }, min_stay: null })) } });

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET';
  if (String(url).includes('api.openphone.com')) { sent.push(JSON.parse(opts.body)); return mk(202, { ok: true }); }
  if (method === 'GET') { const u = new URL(url); return mk(200, calOf(daysInclusive(u.searchParams.get('start_date'), u.searchParams.get('end_date')))); }
  if (method === 'PUT') return mk(500, { status_code: 500, reason_phrase: 'internal error' }); // force failure
  return mk(400, {});
};

process.argv = ['node', 'runner', '--unit', '4-L', '--start', '2026-11-04', '--end', '2026-11-05', '--confirm', '--override-sanity', '--skip-preflight'];
require('./pricing-engine-run.js'); // runs the real runner (async IIFE)

(async () => {
  const start = Date.now();
  while (Date.now() - start < 15000 && !sent.some(m => /RETRY_EXHAUSTED/.test(m.content))) {
    await new Promise(r => setTimeout(r, 200));
  }
  const msg = sent.find(m => /RETRY_EXHAUSTED/.test(m.content));
  assert.ok(msg, 'a REAL OpenPhone alert SMS must be sent when the push fails');
  assert.deepStrictEqual(msg.to, ['+15559999999'], 'sent to NOTIFY_PHONE');
  assert.strictEqual(msg.from, '+15550000001');
  console.log('✓ simulated push-failure (PUT 500 → retry exhausted → abort) sent a REAL alert SMS:');
  console.log(`    OpenPhone POST → ${msg.to}: "${msg.content}"`);
  console.log('\n1/1 passed');
  fs.rmSync(process.env.PRICING_DATA_DIR, { recursive: true, force: true });
  process.exit(0);
})().catch(e => { console.error('✗ FAILED:', e.message); process.exit(1); });
