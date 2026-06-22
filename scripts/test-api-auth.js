// Tests the /api/ auth decision is FAIL-CLOSED: no API_SECRET configured → reject (never open),
// wrong/missing token → reject, correct Bearer → allow. Run: node scripts/test-api-auth.js
'use strict';
const assert = require('assert');
const { checkApiAuth } = require('../src/server'); // require.main guard => no listen/cron/poll

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

check('FAIL-CLOSED: no API_SECRET configured → 401 (price-moving API never unauthenticated)', () => {
  for (const missing of [undefined, null, '']) {
    const r = checkApiAuth(missing, 'Bearer anything');
    assert.strictEqual(r.ok, false, `unset secret must reject (got ok for ${JSON.stringify(missing)})`);
    assert.strictEqual(r.status, 401);
  }
  assert.match(checkApiAuth(undefined, 'Bearer x').error, /not configured/i);
});

check('wrong or missing token → 401', () => {
  assert.strictEqual(checkApiAuth('secret', 'Bearer nope').ok, false);
  assert.strictEqual(checkApiAuth('secret', '').ok, false);
  assert.strictEqual(checkApiAuth('secret', undefined).ok, false);
  assert.strictEqual(checkApiAuth('secret', 'Bearer ').ok, false); // empty token after scheme
});

check('correct token → ok (Bearer prefix optional, unchanged lenient behavior)', () => {
  assert.deepStrictEqual(checkApiAuth('secret', 'Bearer secret'), { ok: true });
  assert.deepStrictEqual(checkApiAuth('secret', 'Bearer  secret '), { ok: true }); // trims
  assert.deepStrictEqual(checkApiAuth('secret', 'secret'), { ok: true });           // raw token (pre-existing)
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
