// Tests the real alert wiring (OpenPhone SMS). Run: node scripts/test-alert-wiring.js
'use strict';
const assert = require('assert');
const { buildAlertSender, OPENPHONE_URL } = require('../src/alert-notify');
const { buildAlert, emitAlert } = require('../src/pricing-resilience');

let pass = 0; const ok = async (n, f) => { await f(); console.log('✓', n); pass++; };
const ENV = { QUO_API_KEY: 'key-123', QUO_FROM_NUMBER: '+15550000001', NOTIFY_PHONE: '+15559999999' };

(async () => {
  await ok('buildAlertSender POSTs to OpenPhone with correct URL/headers/body', async () => {
    const calls = [];
    const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 202, text: async () => 'ok' }; };
    const send = buildAlertSender(ENV, fakeFetch);
    const res = await send(buildAlert('RETRY_EXHAUSTED', '4-L [2026-11-04..05] 500'));
    assert.strictEqual(res.sent, true);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, OPENPHONE_URL);
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'key-123');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(body.to, ['+15559999999']);
    assert.strictEqual(body.from, '+15550000001');
    assert.ok(/PRICING RETRY_EXHAUSTED/.test(body.content), 'content names the failure');
    assert.ok(/4-L/.test(body.content), 'content includes detail');
  });

  await ok('emitAlert(send) routes the alert to the sender AND logs', async () => {
    let logged = '', sent = null;
    const delivery = emitAlert(buildAlert('PUSH_ABORTED', 'x'), { log: (m) => { logged = m; }, send: async (a) => { sent = a; return { sent: true }; } });
    const r = await delivery;
    assert.ok(/\[ALERT\] PUSH_ABORTED/.test(logged), 'still logs');
    assert.strictEqual(sent.type, 'PUSH_ABORTED', 'and sends');
    assert.strictEqual(r.sent, true);
  });

  await ok('no SMS creds → no send, no throw (degrades)', async () => {
    const calls = [];
    const send = buildAlertSender({}, async (u, o) => { calls.push(1); return { ok: true, status: 200, text: async () => '' }; });
    const res = await send(buildAlert('X', 'y'));
    assert.strictEqual(res.sent, false);
    assert.strictEqual(calls.length, 0, 'never calls OpenPhone without creds');
  });

  await ok('OpenPhone failure (throw / non-2xx) never throws — run continues', async () => {
    const t = await buildAlertSender(ENV, async () => { throw new Error('socket hang up'); })(buildAlert('X', 'y'));
    assert.strictEqual(t.sent, false); assert.ok(t.error);
    const f = await buildAlertSender(ENV, async () => ({ ok: false, status: 500, text: async () => 'err' }))(buildAlert('X', 'y'));
    assert.strictEqual(f.sent, false); assert.strictEqual(f.status, 500);
  });

  console.log(`\n${pass}/${pass} passed`);
})().catch(e => { console.error('✗ FAILED:', e.message); process.exit(1); });
