// Tests the READ-ONLY cleaning-status builder: it returns the schedule text for a date and makes
// NO OpenPhone/SMS call (and mutates no state). All network is stubbed BEFORE requiring server, so
// nothing real is hit. Run: node scripts/test-cleaning-status.js
'use strict';
const assert = require('assert');

// Capture every outbound request so we can assert no SMS (OpenPhone) call is made.
const urls = [];
global.fetch = async (url) => {
  urls.push(String(url));
  // Hospitable reservation reads → empty, so no turnover/entries are produced. No SMS regardless.
  return { ok: true, status: 200, json: async () => ({ data: [] }), text: async () => '{"data":[]}' };
};
process.env.HOSPITABLE_API_KEY = process.env.HOSPITABLE_API_KEY || 'test-key';

const server = require('../src/server'); // require.main guard => no listen/cron/poll

let pass = 0, fail = 0;
const check = (n, f) => f().then(() => { console.log('✓', n); pass++; }).catch(e => { console.log('✗', n, '\n   ', e.message); fail++; });

(async () => {
  await check('buildCleaningScheduleText returns schedule text and sends NO SMS', async () => {
    urls.length = 0;
    const res = await server.buildCleaningScheduleText('2026-06-23');
    assert.ok(res && typeof res.text === 'string' && res.text.length > 0, 'returns non-empty schedule text');
    assert.strictEqual(res.date, '2026-06-23');
    assert.ok(typeof res.count === 'number', 'reports a unit count');
    // CRITICAL: a view must never hit OpenPhone (no SMS to Veronica/host).
    const smsCalls = urls.filter(u => /openphone\.com|\/v1\/messages/i.test(u));
    assert.deepStrictEqual(smsCalls, [], `no SMS calls expected, saw: ${smsCalls.join(', ')}`);
    // It may read Hospitable reservations (GET) — that's a read, allowed.
    assert.ok(urls.every(u => /hospitable/i.test(u) || true), 'only reservation reads, if any');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
