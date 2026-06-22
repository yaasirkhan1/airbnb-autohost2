// Tests for the Telegram ops bot dispatch (pure over injected deps — no network):
//   • owner-ID lock rejects every other user id
//   • cleaning override FIRES immediately (no confirmation)
//   • pricing + guest-message commands REQUIRE "yes" before firing
//   • front-desk-form resolves against today's arrivals: one match fires, ambiguous asks
// Run: node scripts/test-telegram-bot.js
'use strict';
const assert = require('assert');
const bot = require('../src/telegram-bot');

let pass = 0, fail = 0;
const tests = [];
const check = (n, f) => tests.push([n, f]);

const OWNER = 123456789;
const update = (text, fromId = OWNER, chatId = OWNER) => ({ update_id: 1, message: { from: { id: fromId }, chat: { id: chatId }, text } });

// A deps factory with spy handlers; `parseReturns` drives the (stubbed) parse step.
function makeDeps(parseReturns) {
  const calls = [];
  const rec = (name) => (arg) => { calls.push([name, arg]); return Promise.resolve(`[${name} ran]`); };
  return {
    calls,
    deps: {
      ownerId: OWNER,
      pending: new Map(),
      parse: async () => parseReturns,
      compose: async ({ gist }) => `Hi! ${gist}. Warmly, Cal`,
      resolveGuest: async (name) => name === 'AMBIG'
        ? { status: 'many', candidates: [{ label: 'Jamie L (21-I, arr 6/22)' }, { label: 'Jamie R (4-L, arr 6/24)' }] }
        : { status: 'one', guest: { label: `${name} (21-I)`, id: 'res_1' } },
      handlers: {
        cleaning_override: rec('cleaning_override'),
        cleaner_message: rec('cleaner_message'),
        checkin_status: rec('checkin_status'),
        checkin_resend: rec('checkin_resend'),
        frontdesk_form: rec('frontdesk_form'),
        guest_message_send: rec('guest_message_send'),
        pricing_adjust: rec('pricing_adjust'),
        pricing_decay_freeze: rec('pricing_decay_freeze'),
      },
    },
  };
}

check('SECURITY: a non-owner user id is ignored entirely — no parse, no reply, no action', async () => {
  const { deps, calls } = makeDeps({ action: 'cleaning_override', ops: [{ op: 'add', unit: '21-I', urgent: true }] });
  let parsed = false;
  deps.parse = async () => { parsed = true; return {}; };
  const out = await bot.handleUpdate(update('add 21-I urgent', 999 /* not owner */), deps);
  assert.strictEqual(out.ignored, true);
  assert.deepStrictEqual(out.replies, []);
  assert.strictEqual(parsed, false, 'must not even parse a non-owner message');
  assert.strictEqual(calls.length, 0);
});

check('isOwner matches only the configured numeric id (string/number tolerant)', () => {
  assert.strictEqual(bot.isOwner(update('x', OWNER), OWNER), true);
  assert.strictEqual(bot.isOwner(update('x', OWNER), String(OWNER)), true);
  assert.strictEqual(bot.isOwner(update('x', 42), OWNER), false);
});

check('cleaning override FIRES immediately (no confirmation gate)', async () => {
  const intent = { action: 'cleaning_override', ops: [{ op: 'add', unit: '21-I', urgent: true }] };
  const { deps, calls } = makeDeps(intent);
  const out = await bot.handleUpdate(update('add 21-I urgent for tomorrow'), deps);
  assert.strictEqual(out.fired, 'cleaning_override');
  assert.deepStrictEqual(calls[0], ['cleaning_override', intent]);
  assert.strictEqual(deps.pending.size, 0, 'no pending confirmation for an immediate action');
});

check('pricing_adjust ECHOES and does NOT fire until "yes"', async () => {
  const intent = { action: 'pricing_adjust', pct: -5, start: '2026-06-20', end: '2026-06-29', units: 'all' };
  const { deps, calls } = makeDeps(intent);
  const first = await bot.handleUpdate(update('lower prices June 20-29 5%'), deps);
  assert.ok(/lower prices/i.test(first.replies[0]), 'echoes the interpreted change');
  assert.strictEqual(calls.length, 0, 'nothing fired yet');
  assert.strictEqual(deps.pending.size, 1);
  // a non-yes/no reply must NOT fire it
  const nudge = await bot.handleUpdate(update('what will it do?'), deps);
  assert.strictEqual(calls.length, 0);
  assert.ok(/pending/i.test(nudge.replies[0]));
  // "yes" fires exactly once
  const go = await bot.handleUpdate(update('yes'), deps);
  assert.strictEqual(go.fired, 'pricing_adjust');
  assert.deepStrictEqual(calls[0], ['pricing_adjust', intent]);
  assert.strictEqual(deps.pending.size, 0);
});

check('pricing change can be cancelled with "no" — nothing applied', async () => {
  const { deps, calls } = makeDeps({ action: 'pricing_decay_freeze', enable: true, days: 7 });
  await bot.handleUpdate(update('turn off decay 7 days out'), deps);
  const cancel = await bot.handleUpdate(update('no'), deps);
  assert.ok(/cancel/i.test(cancel.replies[0]));
  assert.strictEqual(calls.length, 0);
  assert.strictEqual(deps.pending.size, 0);
});

check('guest_message composes + echoes, sends only after "yes"', async () => {
  const intent = { action: 'guest_message', guest: 'Jamie', gist: 'late checkout approved, no charge' };
  const { deps, calls } = makeDeps(intent);
  const draft = await bot.handleUpdate(update('tell Jamie late checkout is approved, no charge'), deps);
  assert.ok(/late checkout approved/i.test(draft.replies[0]), 'shows the composed draft');
  assert.strictEqual(calls.length, 0, 'not sent on draft');
  assert.strictEqual(deps.pending.size, 1);
  const go = await bot.handleUpdate(update('send'), deps);
  assert.strictEqual(go.fired, 'guest_message');
  assert.strictEqual(calls[0][0], 'guest_message_send');
  assert.match(calls[0][1].text, /late checkout approved/i);
});

check('front-desk form: exactly one arrival match FIRES', async () => {
  const intent = { action: 'frontdesk_form', name: 'John Smith' };
  const { deps, calls } = makeDeps(intent);
  // the frontdesk_form handler owns its own arrivals resolution; here it returns a fired result
  deps.handlers.frontdesk_form = (i) => { calls.push(['frontdesk_form', i]); return Promise.resolve('✅ Front-desk form sent for John Smith (21-I)'); };
  const out = await bot.handleUpdate(update('send front desk form for John Smith'), deps);
  assert.strictEqual(out.fired, 'frontdesk_form');
  assert.match(out.replies[0], /sent for John Smith/);
});

check('front-desk form: ambiguous/zero arrivals ASKS instead of firing', async () => {
  const intent = { action: 'frontdesk_form', name: 'John' };
  const { deps, calls } = makeDeps(intent);
  let fired = false;
  deps.handlers.frontdesk_form = (i) => {
    // handler resolved 2 arrivals → returns a question, fires nothing live
    return Promise.resolve('Two arrivals match "John" today — which one? John Smith (21-I) or John Doe (4-L)?');
  };
  const out = await bot.handleUpdate(update('send front desk form for John'), deps);
  assert.match(out.replies[0], /which one/i);
});

check('clarify intent just relays the question', async () => {
  const { deps, calls } = makeDeps({ action: 'clarify', reason: 'Which unit?' });
  const out = await bot.handleUpdate(update('do the thing'), deps);
  assert.deepStrictEqual(out.replies, ['Which unit?']);
  assert.strictEqual(calls.length, 0);
});

(async () => {
  for (const [n, f] of tests) {
    try { await f(); console.log('✓', n); pass++; }
    catch (e) { console.log('✗', n, '\n   ', e.message); fail++; }
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
