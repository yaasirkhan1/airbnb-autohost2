// Unit test for the read-only decay-status builder. Pure — injects freeze store + a fake
// calendar, asserts each night is classified from the right fence, and that the July "why isn't
// it changing" case yields the unfenced/daily-engine explanation.
// Run: node scripts/test-decay-status.js
'use strict';
const assert = require('assert');
const { buildDecayStatus, classifyNight } = require('../src/decay-status');

const TODAY = '2026-06-23';
const ENV = {}; // WC_FILL_OFF unset → WC fence active
let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// ---- classifyNight: one assertion per fence type ----
ok('booked night → booked (decay skips)', () => {
  const r = classifyNight({ unit: '7-B', date: '2026-07-02', todayYmd: TODAY, freezeStore: {}, env: ENV, info: { price: 200, floor: 62, booked: true } });
  assert.strictEqual(r.verdict, 'booked');
});

ok('manual freeze window → frozen (beats WC overlap)', () => {
  const r = classifyNight({ unit: '7-B', date: '2026-06-25', todayYmd: TODAY, freezeStore: { days: 7, setAt: TODAY }, env: ENV, info: null });
  assert.strictEqual(r.verdict, 'frozen');
});

ok('World Cup window (not frozen) → wc-fenced', () => {
  const r = classifyNight({ unit: '7-B', date: '2026-06-20', todayYmd: TODAY, freezeStore: {}, env: ENV, info: null });
  assert.strictEqual(r.verdict, 'wc-fenced');
});

ok('decay campaign date/unit → decay-campaign', () => {
  const r = classifyNight({ unit: '4-L', date: '2026-06-10', todayYmd: TODAY, freezeStore: {}, env: ENV, info: null });
  assert.strictEqual(r.verdict, 'decay-campaign');
  assert.ok(r.reasons.join(' ').includes('campaign'), 'names the campaign');
});

ok('July unfenced, above floor → unfenced + would-drop note', () => {
  const r = classifyNight({ unit: '7-B', date: '2026-07-02', todayYmd: TODAY, freezeStore: {}, env: ENV, info: { price: 200, floor: 62, booked: false } });
  assert.strictEqual(r.verdict, 'unfenced');
  assert.ok(r.reasons.join(' ').includes('above floor'), 'flags above floor');
});

ok('July unfenced, at floor → unfenced + at-floor note', () => {
  const r = classifyNight({ unit: '7-B', date: '2026-07-03', todayYmd: TODAY, freezeStore: {}, env: ENV, info: { price: 62, floor: 62, booked: false } });
  assert.strictEqual(r.verdict, 'unfenced');
  assert.ok(r.reasons.join(' ').includes('at floor'), 'flags at floor');
});

// ---- buildDecayStatus: the real "July 1-7" scenario, freeze OFF ----
ok('freeze OFF + all-July-unfenced range → OFF line + unfenced explainer', () => {
  const units = ['4-L', '7-B'];
  const cal = {
    '4-L': { '2026-07-01': { price: 175, floor: 66, booked: false }, '2026-07-02': { price: 66, floor: 66, booked: false } },
    '7-B': { '2026-07-01': { price: 180, floor: 62, booked: true }, '2026-07-02': { price: 120, floor: 62, booked: false } },
  };
  const s = buildDecayStatus({ start: '2026-07-01', end: '2026-07-02', units, todayYmd: TODAY, freezeStore: {}, env: ENV, calendar: cal });
  assert.strictEqual(s.freeze.active, false);
  assert.ok(s.text.includes('Decay freeze: OFF'), 'shows freeze OFF');
  assert.ok(s.text.toLowerCase().includes('not decay-fenced') || s.text.includes('unfenced'), 'explains unfenced');
  assert.ok(s.text.includes('priced only by the daily 9am engine'), 'gives the daily-engine explainer');
  // 07-01 has 1 booked (7-B) and the date row should note it; 07-02 has 1 at floor (4-L).
  const jul1 = s.byDate.find(d => d.date === '2026-07-01');
  const jul2 = s.byDate.find(d => d.date === '2026-07-02');
  assert.strictEqual(jul1.booked, 1, '07-01 one booked');
  assert.strictEqual(jul2.atFloor, 1, '07-02 one at floor');
});

ok('freeze ON → ON line with window', () => {
  const s = buildDecayStatus({ start: '2026-06-24', end: '2026-06-25', units: ['7-B'], todayYmd: TODAY, freezeStore: { days: 7, setAt: TODAY }, env: ENV, calendar: null });
  assert.strictEqual(s.freeze.active, true);
  assert.ok(s.text.includes('Decay freeze: ON'), 'shows freeze ON');
  assert.ok(s.text.includes('2026-06-30'), 'shows window end (today+7)');
});

console.log(`\n${pass} passed`);
