// Pricing command parser + preview conflict tests. Run: node scripts/test-pricing-command.js
const assert = require('assert');
const { parseCommand, parseDateRange, resolveUnits, buildPreview, nightDates } = require('../src/pricing-command');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// Fixture unit list (bedrooms as Hospitable reports them).
const UNITS = [
  { id: 'id-4L', label: '4-L', bedrooms: 1, name: '4-L' },
  { id: 'id-7B', label: '7-B', bedrooms: 1, name: '7-B' },
  { id: 'id-18A', label: '18-A', bedrooms: 1, name: '18-A' },
  { id: 'id-21D', label: '21-D', bedrooms: 1, name: '21-D' },
  { id: 'id-21I', label: '21-I', bedrooms: 2, name: '21-I' },
  { id: 'id-23N', label: '23-N', bedrooms: 1, name: '23-N' },
  { id: 'id-24L', label: '24-L', bedrooms: 1, name: '24-L' },
];
const REF = new Date('2026-06-04T00:00:00Z');

// ── date parsing ──
ok('date range "Sept 2–6" → 09-02→09-06, 4 nights (checkout exclusive)', () => {
  const r = parseDateRange('Dragon Con Sept 2–6', REF);
  assert.deepStrictEqual(r, { start: '2026-09-02', end: '2026-09-06', nights: 4 });
  assert.deepStrictEqual(nightDates(r), ['2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05']);
});

// ── selector / resolve (verifies "all 1-bedrooms" set) ──
ok('"all 1-bedrooms" resolves to exactly the 6 1BRs (excludes 21-I)', () => {
  const [c] = parseCommand('all 1-bedrooms for Sept 2–6 at $500, 5-night min', REF);
  const u = resolveUnits(c.selector, UNITS).map(x => x.label).sort();
  assert.deepStrictEqual(u, ['18-A', '21-D', '23-N', '24-L', '4-L', '7-B']);
});
ok('"all 2-bedrooms" resolves to exactly [21-I]', () => {
  const [c] = parseCommand('all 2-bedrooms at $750, 5-night min; ', REF);
  assert.deepStrictEqual(resolveUnits(c.selector, UNITS).map(x => x.label), ['21-I']);
});
ok('specific-unit command type parses unit token', () => {
  const [c] = parseCommand('24-L for Sept 2–6 at $300', REF);
  assert.strictEqual(c.selector.type, 'units');
  assert.deepStrictEqual(c.selector.units, ['24-L']);
  assert.deepStrictEqual(resolveUnits(c.selector, UNITS).map(x => x.label), ['24-L']);
});

// ── multi-clause: 2nd clause inherits the 1st clause's date range ──
ok('clause without dates inherits the command date range', () => {
  const cs = parseCommand('all 1-bedrooms for Sept 2–6 at $500, 5-night min; all 2-bedrooms at $750, 5-night min', REF);
  assert.strictEqual(cs.length, 2);
  assert.deepStrictEqual(cs[1].dateRange, { start: '2026-09-02', end: '2026-09-06', nights: 4 });
  assert.strictEqual(cs[1].price, 750);
  assert.strictEqual(cs[1].minNights, 5);
});

// ── (a) min-night > window conflict ──
ok('(a) 5-night min on a 4-night window → UNBOOKABLE conflict on every row', () => {
  const cs = parseCommand('all 1-bedrooms for Sept 2–6 at $500, 5-night min', REF);
  const { rows, hasConflicts } = buildPreview(cs, UNITS, {});
  assert.strictEqual(hasConflicts, true);
  assert.strictEqual(rows.length, 6);
  assert.ok(rows.every(r => r.conflicts.some(c => /MIN-NIGHTS 5 > WINDOW 4/.test(c))), 'all rows flag the min-night conflict');
  assert.ok(rows.every(r => r.blocked), 'all rows blocked');
});
ok('min-night within window → no min-night conflict', () => {
  const cs = parseCommand('all 1-bedrooms for Sept 2–8 at $500, 3-night min', REF); // 6-night window
  const { rows } = buildPreview(cs, UNITS, {});
  assert.ok(rows.every(r => !r.conflicts.some(c => /UNBOOKABLE/.test(c))));
});

// ── (b) type mismatch: a named 2BR unit requested as a 1-bedroom ──
ok('(b) "21-I as a 1-bedroom" → TYPE MISMATCH', () => {
  const cs = parseCommand('21-I as a 1-bedroom for Sept 2–8 at $500', REF);
  const { rows } = buildPreview(cs, UNITS, {});
  assert.ok(rows.some(r => r.unit === '21-I' && r.conflicts.some(c => /TYPE MISMATCH/.test(c))));
});

// ── (c) price below floor ──
ok('(c) 1BR price below $175 floor → BELOW FLOOR conflict', () => {
  const cs = parseCommand('all 1-bedrooms for Sept 2–8 at $150, 2-night min', REF);
  const { rows } = buildPreview(cs, UNITS, {});
  assert.ok(rows.every(r => r.conflicts.some(c => /BELOW FLOOR \$175/.test(c))));
});

// ── old→new carries current price ──
ok('preview shows old→new price from currentPriceByUnit', () => {
  const cs = parseCommand('24-L for Sept 2–8 at $300', REF);
  const { rows } = buildPreview(cs, UNITS, { 'id-24L': 220 });
  assert.strictEqual(rows[0].oldPrice, 220);
  assert.strictEqual(rows[0].newPrice, 300);
});

console.log(`\n${pass} passed`);
