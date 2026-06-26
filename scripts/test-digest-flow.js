'use strict';
// Tests the bot's digest review flow (approve/override/skip/send) end-to-end via handleUpdate,
// including the same-guest conflict guard. Stubbed deps — no network.
const bot = require('../src/telegram-bot');
const s = require('../src/opportunity-scanner');

let pass = 0, fail = 0;
const check = (n, fn) => { (async () => { try { if ((await fn()) === false) throw new Error('false'); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n} — ${e.message}`); fail++; } })(); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); return true; };

const OWNER = 7;
const upd = (text) => ({ message: { from: { id: OWNER }, chat: { id: OWNER }, text } });

// A digest with a Nabil stack (#1 extension, #2 late checkout) + Isael early check-in (#3).
function freshItems() {
  return s.buildDigestItems([
    { type: 'extension', unit: '21-I', propertyId: 'p', reservationId: 'rNabil', guest: 'Nabil', firstName: 'Nabil', dates: { night: '2026-06-27' }, baseline: { calendarPrice: 117 } },
    { type: 'late_checkout', unit: '21-I', propertyId: 'p', reservationId: 'rNabil', guest: 'Nabil', firstName: 'Nabil', dates: { checkout: '2026-06-27' }, baseline: {} },
    { type: 'early_checkin', unit: '4-L', propertyId: 'p', reservationId: 'rIsael', guest: 'Isael', firstName: 'Isael', dates: { checkin: '2026-06-26' }, baseline: {} },
  ], { vacantCount: 4 });
}
function makeDeps() {
  const store = { [OWNER]: { date: '2026-06-27', items: freshItems() } };
  const sent = [];
  return {
    sent, ownerId: OWNER, pending: new Map(),
    activeDigest: (id) => store[id] || null,
    saveDigest: (id, d) => { store[id] = d; },
    clearDigest: (id) => { delete store[id]; },
    sendDigest: async (id, sendable) => { for (const it of sendable) sent.push({ reservationId: it.reservationId, firstName: it.firstName, type: it.type, chosen: it.chosen }); return `sent ${sendable.length}`; },
    parse: async () => { throw new Error('parse must NOT be called while a digest is active'); },
    handlers: {}, _store: store,
  };
}

check('override "1 at $85" applies + re-shows; nothing sent', async () => {
  const deps = makeDeps();
  const r = await bot.handleUpdate(upd('1 at $85'), deps);
  ok(/@ \$85/.test(r.replies[0]), 're-shown with override');
  ok(deps._store[OWNER].items[0].chosen === 85 && deps._store[OWNER].items[0].decision === 'approve', 'persisted override');
  ok(deps.sent.length === 0, 'nothing sent');
  return true;
});

check('CONFLICT: approve both Nabil items then "send" → blocked, nothing sent', async () => {
  const deps = makeDeps();
  await bot.handleUpdate(upd('approve 1 2'), deps);
  const r = await bot.handleUpdate(upd('send'), deps);
  ok(/same guest two upsells/i.test(r.replies[0]), 'conflict warned');
  ok(/Nabil/.test(r.replies[0]), 'names the guest');
  ok(deps.sent.length === 0, 'nothing sent on conflict');
  ok(deps._store[OWNER], 'digest still open');
  return true;
});

check('resolve conflict (skip 2) + approve 3, then "send" → sends only #1 and #3, right threads', async () => {
  const deps = makeDeps();
  await bot.handleUpdate(upd('1 at $85'), deps);   // approve #1 @ $85
  await bot.handleUpdate(upd('skip 2'), deps);     // drop the stacked late-checkout
  await bot.handleUpdate(upd('approve 3'), deps);  // approve early check-in @ $45
  const r = await bot.handleUpdate(upd('send'), deps);
  ok(deps.sent.length === 2, `2 sent, got ${deps.sent.length}`);
  ok(deps.sent.find(x => x.reservationId === 'rNabil').chosen === 85, 'Nabil extension $85');
  ok(deps.sent.find(x => x.reservationId === 'rIsael').chosen === 45, 'Isael early check-in $45');
  ok(!deps.sent.some(x => x.type === 'late_checkout'), 'skipped late-checkout not sent');
  ok(!deps._store[OWNER], 'digest cleared after send');
  ok(/sent 2/.test(r.replies[0]), 'reports send');
  return true;
});

check('"cancel" clears the digest, nothing sent', async () => {
  const deps = makeDeps();
  const r = await bot.handleUpdate(upd('cancel'), deps);
  ok(/cleared/.test(r.replies[0]) && !deps._store[OWNER] && deps.sent.length === 0);
  return true;
});

check('"send" with nothing approved → asks to approve first', async () => {
  const deps = makeDeps();
  const r = await bot.handleUpdate(upd('send'), deps);
  ok(/nothing approved/i.test(r.replies[0]) && deps.sent.length === 0);
  return true;
});

setTimeout(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 300);
