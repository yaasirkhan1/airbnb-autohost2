// TDD for the front-desk contingency detection:
//   (b) broadened regex catches a single-message status-question
//       ("did you send my informations to the concierge desk?")
//   (3) a TIGHT fragment-burst (consecutive very-short guest msgs within ~2 min)
//       catches split requests WITHOUT over-firing on innocent threads.
// Run: node scripts/test-concierge-window.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { fragmentBurst, routeAction } = require('../src/concierge-window');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const CONCIERGE_REGEX = eval('new RegExp(' + src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/)[1] + '\n)');
const matches = t => CONCIERGE_REGEX.test(String(t).toLowerCase().replace(/[’‘]/g, "'"));

// what the poller/webhook will evaluate: the single message OR the tight burst
const fires = (msgs) => {
  const last = msgs[msgs.length - 1].body;
  const burst = fragmentBurst(msgs, { now: Date.parse(msgs[msgs.length - 1].created_at) + 1000 });
  return matches(last) || (!!burst && matches(burst));
};
const BASE = Date.parse('2026-06-01T20:00:00Z');
const thread = (bodies, gapSec = 20) =>
  bodies.map((b, i) => ({ body: b, sender_role: 'guest', created_at: new Date(BASE + i * gapSec * 1000).toISOString() }));

let pass = 0;
const check = (n, f) => { f(); console.log('✓', n); pass++; };

// (b) single-message status-question
check('(b) Kedravious single message MATCHES (no burst needed)', () => {
  assert.ok(matches('Did you guys send my informations over to concierge desk?'));
});

// (3) genuine fragmented request → fires via tight burst
check('(3) genuine fragments → burst forms and MATCHES', () => {
  const t = thread(['Can you send reservation', 'To the front desk', 'Or call']);
  assert.ok(fragmentBurst(t, { now: Date.parse(t[2].created_at) + 1000 }), 'burst should form');
  assert.ok(fires(t));
});
check('(3) each genuine fragment ALONE does not match', () => {
  for (const b of ['Can you send reservation', 'To the front desk', 'Or call'])
    assert.ok(!matches(b), `fragment should miss alone: "${b}"`);
});

// over-fire CONTROLS — innocent threads must stay SILENT
check('control: "send me the wifi info?" + "where is the front desk?" → SILENT', () => {
  assert.ok(!fires(thread(['Can you send me the wifi info?', 'Where is the front desk?'])));
});
check('control: "reservation confirmation? resend it?" + "how do I find the front desk?" → SILENT', () => {
  assert.ok(!fires(thread(['Did you get my reservation confirmation? Can you resend it?', 'How do I find the front desk?'])));
});
check('control: "send me a towel?" + "is the front desk open 24h?" → SILENT', () => {
  assert.ok(!fires(thread(['Can you send me a towel?', 'Is the front desk open 24h?'])));
});

// burst must require ≥2 short consecutive msgs and respect the ~2-min gap
check('burst does not form across a >2-min gap', () => {
  const t = [
    { body: 'Can you send reservation', sender_role: 'guest', created_at: '2026-06-01T20:00:00Z' },
    { body: 'To the front desk',        sender_role: 'guest', created_at: '2026-06-01T20:05:00Z' }, // 5 min later
  ];
  assert.strictEqual(fragmentBurst(t, { now: Date.parse('2026-06-01T20:05:01Z') }), '');
});

// ── PART 1: booking-less front-desk message must ESCALATE to host (SMS),
//    not be dropped. (This is the path that actually reaches Kedravious/Dekarius.)
const conciergeHitFor = (msgs) => {
  const last = msgs[msgs.length - 1].body;
  const burst = fragmentBurst(msgs, { now: Date.parse(msgs[msgs.length - 1].created_at) + 1000 });
  return matches(last) || (!!burst && matches(burst));
};
const route = (msgs, hasBooking) => routeAction({ hasBooking, conciergeHit: conciergeHitFor(msgs) });

check('part1 pure: no booking + front-desk hit → "escalate" (SMS)', () => {
  assert.strictEqual(routeAction({ hasBooking: false, conciergeHit: true }), 'escalate');
});
check('part1 pure: no booking + no hit → "drop"; any booking → "process"', () => {
  assert.strictEqual(routeAction({ hasBooking: false, conciergeHit: false }), 'drop');
  assert.strictEqual(routeAction({ hasBooking: true, conciergeHit: true }), 'process');
  assert.strictEqual(routeAction({ hasBooking: true, conciergeHit: false }), 'process');
});
check('part1: Kedravious booking-less SINGLE message → ESCALATE to host', () => {
  const t = thread(['Did you guys send my informations over to concierge desk?']);
  assert.strictEqual(route(t, false), 'escalate');
});
check('part1: Dekarius booking-less FRAGMENTS → ESCALATE to host', () => {
  const t = thread(['Can you send reservation', 'To the front desk', 'Or call']);
  assert.strictEqual(route(t, false), 'escalate');
});
check('part1: innocent booking-less thread → drop (no SMS spam)', () => {
  const t = thread(['Can you send me the wifi info?', 'Where is the front desk?']);
  assert.strictEqual(route(t, false), 'drop');
});

console.log(`\nRESULT: ${pass}/12 passed`);
