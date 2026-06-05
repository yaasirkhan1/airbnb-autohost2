// Tests for the resilience + contingency layer. Run: node scripts/test-pricing-resilience.js
// Pure functions tested directly; file-touching functions use a throwaway tmp dir.
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../src/pricing-resilience');
const realConfig = require('../src/pricing-config.json');
const { computeNight } = require('../src/pricing-engine');

let pass = 0; const tests = []; const ok = (n, f) => tests.push([n, f]);
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pricing-res-'));

// ════════════════════════ #3 config integrity (bad-config refuses) ════════════════════════
ok('valid real config passes validateConfig', () => {
  const r = R.validateConfig(realConfig);
  assert.strictEqual(r.ok, true, 'real config should be valid: ' + r.errors.join('; '));
});
ok('missing base / missing ceiling / floor>=ceiling are caught', () => {
  const cfg = { units: {
    A: { propertyId: 'a', type: '1BR', floor: 60, ceiling: 600 },          // no base
    B: { propertyId: 'b', type: '1BR', base: 80, floor: 60 },              // no ceiling
    C: { propertyId: 'c', type: '1BR', base: 80, floor: 600, ceiling: 100 }, // floor>=ceiling
  }, decay: [], events: [] };
  const r = R.validateConfig(cfg);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some(e => /A: base missing/.test(e)));
  assert.ok(r.errors.some(e => /B: ceiling missing/.test(e)));
  assert.ok(r.errors.some(e => /C: floor .* >= ceiling/.test(e)));
});
ok('negative price and decay mult>1.0 are caught', () => {
  const cfg = { units: { A: { propertyId: 'a', type: '1BR', base: -5, floor: 60, ceiling: 600 } },
    decay: [{ daysOut: 7, mult: 1.3 }], events: [] };
  const r = R.validateConfig(cfg);
  assert.ok(r.errors.some(e => /base must be > 0/.test(e)));
  assert.ok(r.errors.some(e => /mult 1.3 out of \(0,1\]/.test(e)), 'decay>1 must be rejected');
});
ok('event start>end, invalid date, and min-stay<=0 are caught', () => {
  const cfg = { units: { A: { propertyId: 'a', type: '1BR', base: 80, floor: 60, ceiling: 600 } }, decay: [], events: [
    { name: 'backwards', start: '2026-09-10', end: '2026-09-01', priceMode: 'mult', mult: 1.5 },
    { name: 'feb30', start: '2026-02-30', end: '2026-03-01', priceMode: 'mult', mult: 1.5 },
    { name: 'badmin', start: '2026-09-01', end: '2026-09-02', priceMode: 'set', price1BR: 200, minStay: 0 },
  ] };
  const r = R.validateConfig(cfg);
  assert.ok(r.errors.some(e => /backwards.*after end/.test(e)));
  assert.ok(r.errors.some(e => /feb30.*invalid start date/.test(e)));
  assert.ok(r.errors.some(e => /badmin.*minStay value 0/.test(e)));
});
ok('isRealYmd rejects Feb 30 / Feb 29 non-leap but accepts real dates', () => {
  assert.strictEqual(R.isRealYmd('2026-02-30'), false);
  assert.strictEqual(R.isRealYmd('2026-02-29'), false); // 2026 not a leap year
  assert.strictEqual(R.isRealYmd('2028-02-29'), true);  // leap
  assert.strictEqual(R.isRealYmd('2026-09-04'), true);
});

// ════════════════════════ #1 property-ID verification (mapping drift halts) ═══════════════
ok('verifyPropertyMapping passes when id + bedrooms match', () => {
  const u = { propertyId: 'X', type: '1BR' };
  const r = R.verifyPropertyMapping('4-L', u, { id: 'X', capacity: { bedrooms: 1 } });
  assert.strictEqual(r.ok, true);
});
ok('verifyPropertyMapping HALTs on bedroom drift (1BR config, 2BR property)', () => {
  const u = { propertyId: 'X', type: '1BR' };
  const r = R.verifyPropertyMapping('4-L', u, { id: 'X', capacity: { bedrooms: 2 } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some(x => /mapping drift/.test(x)));
});
ok('verifyPropertyMapping HALTs when returned id != config id', () => {
  const r = R.verifyPropertyMapping('4-L', { propertyId: 'X', type: '1BR' }, { id: 'Y', capacity: { bedrooms: 1 } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.reasons.some(x => /!= config/.test(x)));
});
ok('verifyPropertyMapping fails closed on missing property data', () => {
  assert.strictEqual(R.verifyPropertyMapping('4-L', { propertyId: 'X', type: '1BR' }, null).ok, false);
});

// ════════════════════════ #2 dynamic-pricing detection (halts) ════════════════════════════
ok('isDynamicPricingError matches the 422 body', () => {
  assert.strictEqual(R.isDynamicPricingError('This property has dynamic pricing enabled, and price updates can not be made via the API.'), true);
  assert.strictEqual(R.isDynamicPricingError('rate limited'), false);
});
ok('detectDynamicPricingFromProperty flags explicit on, ignores absence', () => {
  assert.strictEqual(R.detectDynamicPricingFromProperty({ dynamic_pricing_enabled: true }), true);
  assert.strictEqual(R.detectDynamicPricingFromProperty({ settings: { dynamic_pricing: 'on' } }), true);
  assert.strictEqual(R.detectDynamicPricingFromProperty({ capacity: { bedrooms: 1 } }), false); // absence ≠ off-proof
});

// ════════════════════════ #4 cron lock (prevents double-run) ═══════════════════════════════
ok('acquireLock blocks a second run, releaseLock frees it', () => {
  const lf = path.join(TMP, 'a.lock');
  const first = R.acquireLock(lf, { pid: 111 });
  assert.strictEqual(first.acquired, true);
  const second = R.acquireLock(lf, { pid: 222 });            // someone else tries
  assert.strictEqual(second.acquired, false);
  assert.strictEqual(second.heldBy.pid, 111);
  assert.strictEqual(R.releaseLock(lf, { pid: 222 }), false); // can't steal another pid's lock
  assert.strictEqual(R.releaseLock(lf, { pid: 111 }), true);  // owner releases
  assert.strictEqual(R.acquireLock(lf, { pid: 333 }).acquired, true); // now free
});
ok('a STALE lock (killed run) is reclaimable', () => {
  const lf = path.join(TMP, 'b.lock');
  fs.writeFileSync(lf, JSON.stringify({ pid: 999, ts: Date.now() - 3 * 60 * 60 * 1000 })); // 3h old
  assert.strictEqual(R.lockIsStale({ ts: Date.now() - 3 * 3600000 }, Date.now(), 2 * 3600000), true);
  assert.strictEqual(R.acquireLock(lf, { pid: 1 }).acquired, true); // reclaimed
});

// ════════════════════════ #9 transient retry (backs off then gives up) ════════════════════
ok('isTransientError: retry 429/5xx/network, never 4xx', () => {
  assert.strictEqual(R.isTransientError({ status: 429 }), true);
  assert.strictEqual(R.isTransientError({ status: 503 }), true);
  assert.strictEqual(R.isTransientError({ netError: true }), true);
  assert.strictEqual(R.isTransientError({ status: 422 }), false);
  assert.strictEqual(R.isTransientError({ status: 401 }), false);
});
ok('withRetry succeeds after transient failures (backoff doubles)', async () => {
  const delays = []; let n = 0;
  const res = await R.withRetry(
    async () => (++n < 3 ? { ok: false, status: 500 } : { ok: true, status: 200 }),
    { retries: 3, baseMs: 100, sleep: async ms => { delays.push(ms); } });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.attempts, 3);
  assert.deepStrictEqual(delays, [100, 200]); // exponential
});
ok('withRetry gives up after bounded tries (no infinite hammer)', async () => {
  let n = 0;
  const res = await R.withRetry(async () => { n++; return { ok: false, status: 503 }; },
    { retries: 3, baseMs: 1, sleep: async () => {} });
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.gaveUp, true);
  assert.strictEqual(n, 4); // initial + 3 retries, then stop
});
ok('withRetry does NOT retry a 4xx (422 dynamic pricing) — one attempt', async () => {
  let n = 0;
  const res = await R.withRetry(async () => { n++; return { ok: false, status: 422 }; },
    { retries: 3, baseMs: 1, sleep: async () => {} });
  assert.strictEqual(n, 1);
  assert.strictEqual(res.gaveUp, true);
});

// ════════════════════════ #12 snapshot capture + rollback shaping ═════════════════════════
ok('buildSnapshot captures current price + min-stay for nights about to change', () => {
  const pushQueue = [{ label: '4-L', propertyId: 'P', rows: [{ date: '2026-09-04' }, { date: '2026-09-05' }] }];
  const calMaps = { P: { '2026-09-04': { price: 500, minStay: 5 }, '2026-09-05': { price: 120, minStay: null } } };
  const snap = R.buildSnapshot(pushQueue, calMaps, { runId: 'r1' });
  assert.strictEqual(snap.units[0].nights[0].price, 500);
  assert.strictEqual(snap.units[0].nights[0].minStay, 5);
  assert.strictEqual(snap.units[0].nights[1].price, 120);
  assert.ok(snap.capturedAt && snap.runId === 'r1');
});
ok('snapshotToRollbackRows restores prior values, skips unknown-prior nights (fail-closed)', () => {
  const snap = { units: [{ label: '4-L', propertyId: 'P', nights: [
    { date: '2026-09-04', price: 500, minStay: 5 },
    { date: '2026-09-05', price: null, minStay: null }, // unknown prior — must NOT invent a price
  ] }] };
  const rows = R.snapshotToRollbackRows(snap);
  assert.strictEqual(rows[0].rows.length, 1);
  assert.strictEqual(rows[0].rows[0].computed, 500);
  assert.strictEqual(rows[0].rows[0].minStay, 5);
  assert.deepStrictEqual(rows[0].skipped, ['2026-09-05']);
});

// ════════════════════════ #11 idempotency (re-run is a no-op) ═════════════════════════════
ok('computing the same night twice yields identical price + min-stay (deterministic)', () => {
  const a = computeNight(realConfig, '4-L', '2026-09-04', { todayYmd: '2026-06-05', isBooked: false });
  const b = computeNight(realConfig, '4-L', '2026-09-04', { todayYmd: '2026-06-05', isBooked: false });
  assert.deepStrictEqual({ p: a.price, m: a.minStay }, { p: b.price, m: b.minStay });
});
ok('snapshot of an unchanged night set is empty (a clean re-run writes nothing)', () => {
  // rows where computed === oldPrice are filtered before snapshot/push in the runner.
  const rows = [{ date: '2026-09-04', computed: 500, oldPrice: 500 }];
  const toChange = rows.filter(r => r.oldPrice == null || r.computed !== r.oldPrice);
  assert.strictEqual(toChange.length, 0);
});

// ════════════════════════ #8 write audit log ══════════════════════════════════════════════
ok('buildAuditEntries records old→new price + min-stay + trigger', () => {
  const rows = [{ date: '2026-09-04', computed: 500, minStay: 5, oldPrice: 120, oldMinStay: null, event: 'Dragon Con' }];
  const [e] = R.buildAuditEntries('4-L', rows, { runId: 'r1' });
  assert.strictEqual(e.unit, '4-L');
  assert.strictEqual(e.oldPrice, 120);
  assert.strictEqual(e.newPrice, 500);
  assert.strictEqual(e.newMinStay, 5);
  assert.strictEqual(e.trigger, 'Dragon Con');
  assert.ok(e.ts);
});
ok('appendJsonl writes one JSON object per line', () => {
  const f = path.join(TMP, 'audit.log');
  R.appendJsonl(f, { a: 1 }); R.appendJsonl(f, { a: 2 });
  const lines = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepStrictEqual(lines, [{ a: 1 }, { a: 2 }]);
});

// ════════════════════════ #6 dead-man's-switch ════════════════════════════════════════════
ok('recordSuccess + isRunStale: fresh run not stale, old run stale, no record stale', () => {
  const f = path.join(TMP, 'last.json');
  R.recordSuccess(f, { runId: 'r1', written: 7, now: new Date() });
  const fresh = R.isRunStale(R.readLastSuccess(f), { maxHours: 25 });
  assert.strictEqual(fresh.stale, false);

  const old = R.isRunStale({ lastSuccess: new Date(Date.now() - 26 * 3600000).toISOString() }, { maxHours: 25 });
  assert.strictEqual(old.stale, true);
  assert.ok(old.ageHours > 25);

  assert.strictEqual(R.isRunStale(null, { maxHours: 25 }).stale, true); // never ran → stale
});

// ════════════════════════ #5/#7 summary + alert shaping ═══════════════════════════════════
ok('buildRunSummary + buildAlert produce structured, send-ready objects', () => {
  const s = R.buildRunSummary({ runId: 'r1', window: '2026-06-05..2027-06-05', priced: 100, written: 7, unitsSkipped: ['4-L (fetch)'] });
  assert.strictEqual(s.priced, 100);
  assert.strictEqual(s.written, 7);
  assert.deepStrictEqual(s.unitsSkipped, ['4-L (fetch)']);
  const a = R.buildAlert('SANITY_HALT', 'max move 700%');
  assert.strictEqual(a.level, 'ALERT');
  assert.strictEqual(a.type, 'SANITY_HALT');
});

// run all (sync + async) sequentially
(async () => {
  for (const [n, f] of tests) { await f(); console.log('✓', n); pass++; }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(`\n${pass} passed`);
})().catch(e => { console.error('✗ FAILED:', e.message); process.exit(1); });
