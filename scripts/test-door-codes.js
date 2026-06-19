'use strict';
// Tests for the per-unit door-code store + check-in template binding. Run: node scripts/test-door-codes.js
// Uses DUMMY codes only — the real codes live solely in the gitignored volume store (data/door-codes.json).
const assert = require('assert');
const dc = require('../src/door-codes');
const tmpl = require('../src/checkin-template');
const propsMap = require('../data/properties-map.json');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// label -> propertyId (uuid), from the real (non-secret) properties map.
const idByLabel = {};
for (const [id, e] of Object.entries(propsMap)) if (e.label) idByLabel[e.label] = id;

// Distinct DUMMY codes per unit (NOT the real door codes).
const STORE = { '4-L': '1001', '7-B': '1002', '18-A': '1003', '21-D': '1004', '21-I': '1005', '23-N': '1006', '24-L': '1007' };

check('canonicalUnit normalizes loose tokens; rejects unknown', () => {
  for (const t of ['21-I', '21i', 'apt 21-I', 'Apt 21-I', ' 21 i ']) assert.strictEqual(dc.canonicalUnit(t), '21-I');
  assert.strictEqual(dc.canonicalUnit('99-Z'), null);
  assert.strictEqual(dc.canonicalUnit(''), null);
});

check('normalizeCode accepts 4–8 digits only', () => {
  assert.strictEqual(dc.normalizeCode('3562'), '3562');
  assert.strictEqual(dc.normalizeCode('abc'), null);
  assert.strictEqual(dc.normalizeCode('12'), null);
  assert.strictEqual(dc.normalizeCode('123456789'), null);
});

check('getDoorCode returns EXACTLY the requested unit; unknown/unset → null', () => {
  for (const [u, code] of Object.entries(STORE)) assert.deepStrictEqual(dc.getDoorCode(STORE, u), { unit: u, code });
  assert.strictEqual(dc.getDoorCode(STORE, '99-Z'), null);  // unknown unit
  assert.strictEqual(dc.getDoorCode({}, '21-I'), null);     // unit known but code unset
});

check('setDoorCode validates unit + code (no bad value ever persisted)', () => {
  assert.deepStrictEqual(dc.setDoorCode({}, 'apt 21-I', '3562')['21-I'], { code: '3562' });
  assert.throws(() => dc.setDoorCode({}, '99-Z', '3562'), /unknown unit/);
  assert.throws(() => dc.setDoorCode({}, '21-I', 'abc'), /invalid code/);
});

check("BINDING: each unit's reservation gets ONLY its own code — never another unit's", () => {
  const allCodes = Object.values(STORE);
  for (const [unit, code] of Object.entries(STORE)) {
    const id = idByLabel[unit];
    assert.ok(id, `properties-map has ${unit}`);
    const reservation = { listing_id: id, guest: { first_name: 'Test' }, check_in: '2026-06-20', check_out: '2026-06-22' };
    const { fields } = tmpl.resolveCheckin(reservation, propsMap, STORE, { hostName: 'HostAcct' });
    assert.strictEqual(fields.unit, unit, `${unit} resolves to its own unit`);
    assert.strictEqual(fields.doorCode, code, `${unit} resolves its OWN code`);
    assert.strictEqual(fields.hostName, 'HostAcct', 'host name comes from the responding account, not hardcoded');
    const msg = tmpl.renderCheckinInstructions(fields);
    assert.ok(msg.includes(code), `${unit} message shows its code`);
    for (const other of allCodes) {
      if (other !== code) assert.ok(!msg.includes(other), `${unit} message must NOT contain another unit's code (${other})`);
    }
  }
});

check('unknown property → no code, flagged missing (never a fallback code)', () => {
  const { fields, missing } = tmpl.resolveCheckin(
    { listing_id: 'no-such-id', guest: { first_name: 'X' }, check_in: 'a', check_out: 'b' }, propsMap, STORE);
  assert.strictEqual(fields.doorCode, null);
  assert.ok(missing.includes('unit') || missing.includes('doorCode'));
});

// ── Wi-Fi (stored per-unit alongside the codes) ──────────────────────────────
const WIFI_STORE = {
  '21-I': { code: '3562', wifi_name: '21-i' },                                  // explicit SSID casing
  '24-L': { code: '7424' },                                                     // default rule
  '7-B':  { code: '3298', wifi_name: 'ARRIS-4A75-5G', wifi_password: '3G5344101127' }, // exception
  '18-A': { code: '8651' },                                                     // default rule
};

check('getWifi: explicit SSID/password win; default rule fills the rest (name=label, shared pw)', () => {
  assert.deepStrictEqual(dc.getWifi(WIFI_STORE, '21-I'), { unit: '21-I', name: '21-i', password: '9545522122' });
  assert.deepStrictEqual(dc.getWifi(WIFI_STORE, '24-L'), { unit: '24-L', name: '24-L', password: '9545522122' });
  assert.deepStrictEqual(dc.getWifi(WIFI_STORE, '7-B'),  { unit: '7-B', name: 'ARRIS-4A75-5G', password: '3G5344101127' });
  assert.deepStrictEqual(dc.getWifi(WIFI_STORE, '18-A'), { unit: '18-A', name: '18-A', password: '9545522122' });
  assert.strictEqual(dc.getWifi(WIFI_STORE, '99-Z'), null);
});

check('setWifi validates + preserves code; setDoorCode preserves wifi (one per-unit record)', () => {
  let s = dc.setWifi({}, 'apt 7-b', 'ARRIS-4A75-5G', '3G5344101127');
  assert.deepStrictEqual(s['7-B'], { wifi_name: 'ARRIS-4A75-5G', wifi_password: '3G5344101127' });
  s = dc.setDoorCode(s, '7-B', '3298');               // adding the code must keep the wifi
  assert.deepStrictEqual(s['7-B'], { wifi_name: 'ARRIS-4A75-5G', wifi_password: '3G5344101127', code: '3298' });
  assert.throws(() => dc.setWifi({}, '99-Z', 'x', 'y'), /unknown unit/);
  assert.throws(() => dc.setWifi({}, '7-B', '', 'y'), /name/);
  assert.throws(() => dc.setWifi({}, '7-B', 'x', ''), /password/);
});

check('wifi is bound per-unit: 7-B → ARRIS, 21-I → 21-i, never swapped', () => {
  assert.strictEqual(dc.getWifi(WIFI_STORE, '7-B').name, 'ARRIS-4A75-5G');
  assert.strictEqual(dc.getWifi(WIFI_STORE, '21-I').name, '21-i');
  assert.notStrictEqual(dc.getWifi(WIFI_STORE, '7-B').name, dc.getWifi(WIFI_STORE, '21-I').name);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
