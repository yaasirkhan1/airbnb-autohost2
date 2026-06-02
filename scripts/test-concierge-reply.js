// Fix 2 — a front-desk request detected via FRAGMENT-BURST must get the exact
// hardcoded "form emailed, tell the concierge to check their email" reply, NOT
// Claude's freeform wording.
//
// We test the pure pieces the server uses:
//   conciergeGuestReply(name)            — the exact wording (single source of truth)
//   conciergeHardcodedReply({conciergeHit, guestName}) — routes hit → hardcoded reply
// plus an end-to-end fragment check: a split request forms a burst that the regex
// matches, and that hit maps to the precise reply (not Claude).
//
// Run: node scripts/test-concierge-reply.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { conciergeGuestReply, conciergeHardcodedReply } = require('../src/concierge-email');
const { fragmentBurst } = require('../src/concierge-window');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const CONCIERGE_REGEX = eval('new RegExp(' + src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/)[1] + '\n)');
const regexHit = t => CONCIERGE_REGEX.test(String(t).toLowerCase().replace(/[’‘]/g, "'"));

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// The exact wording the guest must receive.
check('conciergeGuestReply has the precise wording + first name', () => {
  const r = conciergeGuestReply('Dekarius Pitts');
  assert.ok(r.startsWith('Hi Dekarius,'), 'should greet by first name');
  assert.ok(/form was sent out this morning/i.test(r), 'missing "form was sent out this morning"');
  assert.ok(/emailed the front desk/i.test(r), 'missing "emailed the front desk"');
  assert.ok(/check their email/i.test(r), 'missing "check their email"');
  assert.ok(/let you up/i.test(r), 'missing "let you up"');
});

check('routing: conciergeHit=true → exact hardcoded reply, confident', () => {
  const out = conciergeHardcodedReply({ conciergeHit: true, guestName: 'Kedravious Webb' });
  assert.strictEqual(out.confident, true);
  assert.strictEqual(out.reply, conciergeGuestReply('Kedravious Webb'));
});

check('routing: conciergeHit=false → null (falls through to Claude)', () => {
  assert.strictEqual(conciergeHardcodedReply({ conciergeHit: false, guestName: 'X' }), null);
});

// End-to-end: Dekarius's split request → burst forms → regex matches the burst →
// that hit must select the PRECISE reply (proving fragmented requests don't hit Claude).
check('fragmented request → burst hit → precise reply (not Claude)', () => {
  const BASE = Date.parse('2026-06-01T20:00:00Z');
  const thread = ['Can you send reservation', 'To the front desk', 'Or call']
    .map((b, i) => ({ body: b, sender_role: 'guest', created_at: new Date(BASE + i * 20000).toISOString() }));
  const burst = fragmentBurst(thread, { now: Date.parse(thread[2].created_at) + 1000 });
  // No single fragment matches alone...
  for (const m of thread) assert.ok(!regexHit(m.body), `fragment matched alone: "${m.body}"`);
  // ...but the burst does, and that drives the hardcoded reply.
  const conciergeHit = regexHit(burst);
  assert.ok(conciergeHit, 'burst should match the regex');
  const out = conciergeHardcodedReply({ conciergeHit, guestName: 'Dekarius' });
  assert.strictEqual(out.reply, conciergeGuestReply('Dekarius'));
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
