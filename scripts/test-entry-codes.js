// TDD for per-unit emergency entry codes.
// Run: node scripts/test-entry-codes.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isEntryCodeRequest, resolveEntryCode, entryCodeReply, loadEntryCodes } = require('../src/entry-codes');

let pass = 0;
const check = (name, fn) => { fn(); console.log('✓', name); pass++; };

// ── Request detection ──
const FIRE = [
  'Do you have an entry code for me?',
  "What's the door code?",
  'what is my entry code',
  'can you send me the code to get in',
  'what’s the code',                       // curly apostrophe (mobile)
  'I need the code to get into the building',
];
const NOFIRE = [
  'what time is checkout?',
  'is there a promo code?',
  "what's the wifi password?",
  'can I check in early at 1pm?',
  'the area code for atlanta',
];
check('entry-code questions are detected', () => {
  for (const m of FIRE) assert.ok(isEntryCodeRequest(m), `should detect: ${m}`);
});
check('non-code messages are NOT detected', () => {
  for (const m of NOFIRE) assert.ok(!isEntryCodeRequest(m), `should NOT detect: ${m}`);
});

// ── reservation→unit→code resolution (right code to right guest) ──
const PROPS = {
  '80c21aac-00eb-49af-9094-6792839ff5a4': { label: '21-D' },
  '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c': { label: '21-I' },
  'bbe43523-c42a-46b0-8235-7ad08ae990c9': { label: '4-L' },
};
const CODES = { '21-D': '4827', '21-I': '', '4-L': '1199' }; // 21-I has NO code yet

check('resolves the correct code for the guest’s unit (21-D → 4827)', () => {
  assert.deepStrictEqual(resolveEntryCode('80c21aac-00eb-49af-9094-6792839ff5a4', PROPS, CODES),
    { unit: '21-D', code: '4827' });
});
check('does NOT mix up units (4-L → 1199, never 4827)', () => {
  assert.deepStrictEqual(resolveEntryCode('bbe43523-c42a-46b0-8235-7ad08ae990c9', PROPS, CODES),
    { unit: '4-L', code: '1199' });
});
check('unit with no code set → null (escalate, never send empty)', () => {
  assert.strictEqual(resolveEntryCode('7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', PROPS, CODES), null);
});
check('unknown property id → null', () => {
  assert.strictEqual(resolveEntryCode('not-a-real-uuid', PROPS, CODES), null);
});
check('missing property id → null', () => {
  assert.strictEqual(resolveEntryCode(null, PROPS, CODES), null);
});

// ── reply formatting ──
check('reply contains the right code, unit, and guest first name — and no other code', () => {
  const r = entryCodeReply('Jeremy Smith', '21-D', '4827');
  assert.ok(r.includes('4827'), 'has the code');
  assert.ok(r.includes('21-D'), 'has the unit');
  assert.ok(r.includes('Jeremy'), 'has the first name');
  assert.ok(!r.includes('1199'), 'must not leak another unit code');
});

// ── loader: file + env var, strips _format key ──
check('loadEntryCodes reads the file and strips _format', () => {
  const f = path.join(os.tmpdir(), `ec-${Date.now()}.json`);
  fs.writeFileSync(f, JSON.stringify({ _format: 'doc', '21-D': '4827' }));
  const c = loadEntryCodes(f);
  assert.deepStrictEqual(c, { '21-D': '4827' });
  fs.unlinkSync(f);
});
check('ENTRY_CODES_JSON env var overrides the file (keeps codes out of git)', () => {
  const prev = process.env.ENTRY_CODES_JSON;
  process.env.ENTRY_CODES_JSON = JSON.stringify({ '7-B': '9090' });
  try {
    assert.deepStrictEqual(loadEntryCodes('/nonexistent/path.json'), { '7-B': '9090' });
  } finally {
    if (prev === undefined) delete process.env.ENTRY_CODES_JSON; else process.env.ENTRY_CODES_JSON = prev;
  }
});

console.log(`\nRESULT: ${pass}/10 passed`);
