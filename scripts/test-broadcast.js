'use strict';
// Tests for the "draft a message to an audience, approve before send" capability.
const a = require('../src/audience');
const bot = require('../src/telegram-bot');

let pass = 0, fail = 0;
const check = (n, fn) => { (async () => { try { if ((await fn()) === false) throw new Error('false'); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n} — ${e.message}`); fail++; } })(); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); return true; };

// ── (1) AUDIENCE RESOLUTION from natural language ───────────────────────────
check('audience: "message today\'s arrivals ..." → arrivals_today', () => a.parseAudience("message today's arrivals about early check-in").kind === 'arrivals_today');
check('audience: "everyone checking out tomorrow" → checkouts_tomorrow', () => a.parseAudience('everyone checking out tomorrow').kind === 'checkouts_tomorrow');
check('audience: "guests checking out today" → checkouts_today', () => a.parseAudience('guests checking out today').kind === 'checkouts_today');
check('audience: "current guests" → current_guests', () => a.parseAudience('message current guests about the rooftop').kind === 'current_guests');
check('audience: "guests in 4-L and 18-A" → units [4-L,18-A]', () => {
  const s = a.parseAudience('guests in 4-L and 18-A'); return s.kind === 'units' && s.units.join(',') === '4-L,18-A';
});
check('audience: gibberish → null (ask to clarify)', () => a.parseAudience('the blue thing over there') === null);
check('describeAudience reads naturally', () => /today's arrivals — 3 guests/.test(a.describeAudience({ kind: 'arrivals_today' }, 3)));

// ── (4) PERSONALIZATION: one core message, per-recipient name ────────────────
check('personalize fills {first_name}', () => a.personalize('Hi {first_name}! Welcome.', 'Nabil') === 'Hi Nabil! Welcome.');
check('personalize handles a full name → first token', () => a.personalize('Hey {first_name},', 'Rebecka Lindgren') === 'Hey Rebecka,');
check('personalize greets if token missing', () => /^Hi Sam! /.test(a.personalize('Your room is ready.', 'Sam')));

// ── per-thread send guard: each body keyed to that member's OWN thread + name ─
check('renderBroadcast: right body → right thread, no cross-contamination', () => {
  const members = [
    { reservationId: 'resv_A', firstName: 'Nabil', unit: '4-L' },
    { reservationId: 'resv_B', firstName: 'Rebecka', unit: '18-A' },
  ];
  const out = a.renderBroadcast(members, 'Hi {first_name}! Early check-in is available for $45.');
  ok(out.length === 2);
  const A = out.find(x => x.reservationId === 'resv_A'), B = out.find(x => x.reservationId === 'resv_B');
  ok(/Nabil/.test(A.body) && !/Rebecka/.test(A.body), 'A is Nabil only');
  ok(/Rebecka/.test(B.body) && !/Nabil/.test(B.body), 'B is Rebecka only');
  ok(/\$45/.test(A.body) && /\$45/.test(B.body), 'core message consistent');
  return true;
});

// ── (3) APPROVAL FLOW via handleUpdate (stubbed deps, no network/model) ──────
const OWNER = 7;
const upd = (text) => ({ message: { from: { id: OWNER }, chat: { id: OWNER }, text } });
function makeDeps() {
  const sent = [];           // records every send (reservationId + body)
  const composeCalls = [];   // records compose invocations (to prove edit→revise)
  const members = [
    { reservationId: 'resv_A', firstName: 'Nabil', unit: '4-L', guestName: 'Nabil' },
    { reservationId: 'resv_B', firstName: 'Rebecka', unit: '18-A', guestName: 'Rebecka' },
  ];
  return {
    sent, composeCalls, members,
    ownerId: OWNER, pending: new Map(),
    parse: async () => ({ action: 'broadcast_message', audience: "today's arrivals", goal: 'offer early check-in for the World Cup weekend at $45' }),
    resolveAudience: async () => ({ selector: { kind: 'arrivals_today' }, members, describe: "today's arrivals — 2 guests" }),
    composeCampaign: async ({ goal, prior, edit }) => {
      composeCalls.push({ goal, prior, edit });
      if (edit) return `Hi {first_name}! (warmer) Early check-in for the World Cup weekend is available for $45 — no need to wait.`;
      return `Hi {first_name}! Since you're arriving for the World Cup weekend, early check-in is available for just $45 — settle in and start enjoying Atlanta sooner.`;
    },
    handlers: {
      broadcast_send: async ({ members, message }) => {
        for (const r of a.renderBroadcast(members, message)) sent.push(r);
        return `✅ Sent to ${sent.length}/${members.length} guests.`;
      },
    },
  };
}

check('SCENARIO draft: shows audience + count + message; NOTHING sent yet', async () => {
  const deps = makeDeps();
  const r = await bot.handleUpdate(upd("message today's arrivals about early check-in for the World Cup weekend at $45"), deps);
  ok(/today's arrivals — 2 guests/.test(r.replies[0]), 'shows audience');
  ok(/Nabil \(4-L\)/.test(r.replies[0]) && /Rebecka \(18-A\)/.test(r.replies[0]), 'lists recipients');
  ok(/approve/i.test(r.replies[0]), 'asks for approval');
  ok(deps.sent.length === 0, 'APPROVE-BEFORE-SEND: nothing sent on draft');
  ok(deps.pending.get(OWNER) && deps.pending.get(OWNER).kind === 'broadcast_message', 'draft pending');
  return true;
});

check('SCENARIO edit: a non-yes reply revises the draft and re-shows; still nothing sent', async () => {
  const deps = makeDeps();
  await bot.handleUpdate(upd('message today\'s arrivals about early check-in'), deps);   // draft
  const r = await bot.handleUpdate(upd('make it a bit warmer'), deps);                    // edit
  ok(deps.composeCalls.length === 2 && deps.composeCalls[1].edit === 'make it a bit warmer', 'recomposed with the edit');
  ok(/updated/i.test(r.replies[0]) && /warmer/i.test(r.replies[0]), 're-shown updated draft');
  ok(deps.sent.length === 0, 'still nothing sent after an edit');
  return true;
});

check('SCENARIO approve: "approve" sends to EACH thread, personalized; only then', async () => {
  const deps = makeDeps();
  await bot.handleUpdate(upd('message today\'s arrivals about early check-in'), deps);   // draft
  ok(deps.sent.length === 0, 'pre-approval: nothing sent');
  const r = await bot.handleUpdate(upd('approve'), deps);                                 // approve
  ok(r.fired === 'broadcast_message', 'fired the send');
  ok(deps.sent.length === 2, 'sent to both');
  const A = deps.sent.find(s => s.reservationId === 'resv_A'), B = deps.sent.find(s => s.reservationId === 'resv_B');
  ok(/Nabil/.test(A.body) && /Rebecka/.test(B.body), 'each thread got its own name');
  ok(!/Rebecka/.test(A.body) && !/Nabil/.test(B.body), 'no cross-thread leakage');
  ok(!deps.pending.get(OWNER), 'pending cleared after send');
  return true;
});

check('SCENARIO cancel: "no" cancels, nothing sent', async () => {
  const deps = makeDeps();
  await bot.handleUpdate(upd('message today\'s arrivals about early check-in'), deps);
  const r = await bot.handleUpdate(upd('no'), deps);
  ok(/cancel/i.test(r.replies[0]) && deps.sent.length === 0 && !deps.pending.get(OWNER), 'cancelled, nothing sent');
  return true;
});

setTimeout(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 300);
