// Tests the one-off cleaner SMS sender (Veronica) used by POST /api/cleaner-message.
// Pure/injected fetch — no network, no real creds. Run: node scripts/test-cleaner-message.js
'use strict';
const assert = require('assert');
const { buildCleanerSender, validateMessage, CLEANER_PHONE, OPENPHONE_URL } = require('../src/cleaner-message');

let pass = 0; const ok = async (n, f) => { await f(); console.log('✓', n); pass++; };
const ENV = { QUO_API_KEY: 'key-123', QUO_FROM_NUMBER: '+16785396633' };

(async () => {
  await ok('validateMessage trims, rejects empty/whitespace, clamps to 1000', () => {
    assert.strictEqual(validateMessage('  hola  ').message, 'hola');
    assert.strictEqual(validateMessage('').error ? true : false, true);
    assert.strictEqual(validateMessage('   ').error ? true : false, true);
    assert.strictEqual(validateMessage(null).error ? true : false, true);
    assert.strictEqual(validateMessage('x'.repeat(1500)).message.length, 1000);
  });

  await ok('sends to Veronica with correct URL/headers/body', async () => {
    const calls = [];
    const fakeFetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, status: 202, text: async () => 'ok' }; };
    const send = buildCleanerSender(ENV, fakeFetch);
    const res = await send('Limpieza 4-L mañana 11AM');
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 202);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].url, OPENPHONE_URL);
    assert.strictEqual(calls[0].opts.method, 'POST');
    assert.strictEqual(calls[0].opts.headers.Authorization, 'key-123');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepStrictEqual(body.to, [CLEANER_PHONE], 'goes to the cleaner number');
    assert.strictEqual(body.from, '+16785396633');
    assert.strictEqual(body.content, 'Limpieza 4-L mañana 11AM', 'arbitrary content passed through verbatim');
  });

  await ok('CLEANER_PHONE env override wins over the default', async () => {
    const calls = [];
    const send = buildCleanerSender({ ...ENV, CLEANER_PHONE: '+15551234567' }, async (u, o) => { calls.push(o); return { ok: true, status: 202 }; });
    await send('hi');
    assert.deepStrictEqual(JSON.parse(calls[0].body).to, ['+15551234567']);
  });

  await ok('empty message never calls OpenPhone', async () => {
    const calls = [];
    const res = await buildCleanerSender(ENV, async () => { calls.push(1); return { ok: true, status: 202 }; })('   ');
    assert.strictEqual(res.ok, false);
    assert.ok(/required/.test(res.reason));
    assert.strictEqual(calls.length, 0);
  });

  await ok('no creds → no send, no throw (degrades, returns to)', async () => {
    const calls = [];
    const res = await buildCleanerSender({}, async () => { calls.push(1); return { ok: true, status: 202 }; })('hola');
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'not configured');
    assert.strictEqual(res.to, CLEANER_PHONE);
    assert.strictEqual(calls.length, 0);
  });

  await ok('OpenPhone failure (throw / non-2xx) never throws', async () => {
    const t = await buildCleanerSender(ENV, async () => { throw new Error('socket hang up'); })('hola');
    assert.strictEqual(t.ok, false); assert.ok(t.error);
    const f = await buildCleanerSender(ENV, async () => ({ ok: false, status: 500, text: async () => 'err' }))('hola');
    assert.strictEqual(f.ok, false); assert.strictEqual(f.status, 500);
  });

  console.log(`\n${pass}/${pass} passed`);
})().catch(e => { console.error('✗ FAILED:', e.message); process.exit(1); });
