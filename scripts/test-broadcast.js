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

// ── RECIPIENT-EDIT parsing (the bug fix) ────────────────────────────────────
const FOUR = [
  { reservationId: 'resv_A', firstName: 'Nabil', unit: '4-L', guestName: 'Nabil' },
  { reservationId: 'resv_B', firstName: 'Rebecka', unit: '18-A', guestName: 'Rebecka' },
  { reservationId: 'resv_C', firstName: 'Madison', unit: '21-D', guestName: 'Madison' },
  { reservationId: 'resv_D', firstName: 'Tom', unit: '24-L', guestName: 'Tom' },
];
check('parse: "no 21-D and no 24-L, the rest are fine" → remove those units, no wording edit', () => {
  const r = a.parseRecipientEdit('no 21-D and no 24-L, the rest are fine', FOUR);
  ok(r.removeUnits.sort().join(',') === '21-D,24-L', 'units'); ok(r.textEdit === null, 'no text edit'); ok(r.hasRecipientChange);
  return true;
});
check('parse: "remove Madison" → remove by guest name', () => {
  const r = a.parseRecipientEdit('remove Madison', FOUR); return r.removeNames.includes('Madison') && r.textEdit === null;
});
check('parse: "not 24-L" → remove', () => a.parseRecipientEdit('not 24-L', FOUR).removeUnits.join() === '24-L');
check('parse: "also add 7-B" → add unit', () => {
  const r = a.parseRecipientEdit('also add 7-B', FOUR); return r.addUnits.join() === '7-B' && r.textEdit === null;
});
check('parse: "drop 24-L and make it shorter" → BOTH remove + wording edit', () => {
  const r = a.parseRecipientEdit('drop 24-L and make it shorter', FOUR);
  ok(r.removeUnits.join() === '24-L', 'removed unit'); ok(/make it shorter/.test(r.textEdit), 'wording edit'); return true;
});
check('parse: "make it warmer" → wording edit only, NO recipient change', () => {
  const r = a.parseRecipientEdit('make it warmer', FOUR); return !r.hasRecipientChange && /warmer/.test(r.textEdit);
});
check('applyRecipientRemovals filters by unit + name', () => {
  const left = a.applyRecipientRemovals(FOUR, { removeUnits: ['21-D'], removeNames: ['Tom'] });
  return left.length === 2 && left.every(m => m.unit !== '21-D' && m.firstName !== 'Tom');
});

// ── Flow: amend recipients via a reply to a pending draft ────────────────────
function makeDeps4() {
  const sent = [], composeCalls = [];
  return {
    sent, composeCalls, ownerId: OWNER, pending: new Map(),
    parse: async () => ({ action: 'broadcast_message', audience: 'current guests', goal: 'rooftop event tonight' }),
    resolveAudience: async () => ({ selector: { kind: 'current_guests' }, members: FOUR.slice(), describe: 'current in-house guests — 4 guests' }),
    resolveUnits: async (units) => units.includes('7-B') ? [{ reservationId: 'resv_E', firstName: 'Sam', unit: '7-B', guestName: 'Sam' }] : [],
    composeCampaign: async ({ edit }) => { composeCalls.push(edit || null); return `Hi {first_name}! Rooftop tonight${edit ? ' (' + edit + ')' : ''}.`; },
    handlers: { broadcast_send: async ({ members, message }) => { for (const r of a.renderBroadcast(members, message)) sent.push(r); return `sent ${sent.length}`; } },
  };
}
const draft4 = async (deps) => bot.handleUpdate(upd('message current guests about the rooftop'), deps);

check('FLOW: "no 21-D and 24-L" drops those recipients; message unchanged (no recompose)', async () => {
  const deps = makeDeps4(); await draft4(deps);
  const composeBefore = deps.composeCalls.length;
  const r = await bot.handleUpdate(upd('no 21-D and 24-L'), deps);
  const m = deps.pending.get(OWNER).members.map(x => x.unit).sort();
  ok(m.join() === '18-A,4-L', `recipients now ${m}`);
  ok(deps.composeCalls.length === composeBefore, 'message NOT recomposed');
  ok(/recipients updated/.test(r.replies[0]) && /Nabil/.test(r.replies[0]) && !/Madison/.test(r.replies[0]), 're-shown corrected list');
  return true;
});
check('FLOW: "remove Madison" filters that guest', async () => {
  const deps = makeDeps4(); await draft4(deps);
  await bot.handleUpdate(upd('remove Madison'), deps);
  return !deps.pending.get(OWNER).members.some(m => m.firstName === 'Madison');
});
check('FLOW: "also add 7-B" resolves + adds the unit', async () => {
  const deps = makeDeps4(); await draft4(deps);
  await bot.handleUpdate(upd('also add 7-B'), deps);
  return deps.pending.get(OWNER).members.some(m => m.unit === '7-B' && m.firstName === 'Sam');
});
check('FLOW: "drop 24-L and make it shorter" → removes AND recomposes', async () => {
  const deps = makeDeps4(); await draft4(deps);
  const r = await bot.handleUpdate(upd('drop 24-L and make it shorter'), deps);
  ok(!deps.pending.get(OWNER).members.some(m => m.unit === '24-L'), '24-L gone');
  ok(deps.composeCalls.includes('make it shorter'), 'recomposed with wording edit');
  ok(/recipients \+ message updated/.test(r.replies[0]), 'preview notes both');
  return true;
});
check('FLOW: "approve" after amend sends ONLY to the amended list', async () => {
  const deps = makeDeps4(); await draft4(deps);
  await bot.handleUpdate(upd('no 21-D and 24-L'), deps);   // amend → 2 left
  await bot.handleUpdate(upd('approve'), deps);            // send
  const ids = deps.sent.map(s => s.reservationId).sort();
  ok(ids.join() === 'resv_A,resv_B', `sent only to amended list: ${ids}`);
  ok(!deps.sent.some(s => /Madison|Tom/.test(s.body)), 'dropped guests not messaged');
  return true;
});

// ── NAMED-UNIT precedence (bug #2: named units were ignored) ────────────────
check('named units: "guests in 4-L, 18-A, and 21-I" → EXACTLY those 3 units', () => {
  const s = a.parseAudience('guests in 4-L, 18-A, and 21-I');
  return s.kind === 'units' && s.units.join(',') === '4-L,18-A,21-I';
});
check('named units: "guests in 4-L and 7-B" → EXACTLY those 2', () => {
  const s = a.parseAudience('guests in 4-L and 7-B');
  return s.kind === 'units' && s.units.join(',') === '4-L,7-B';
});
check('PRECEDENCE FIX: "today\'s arrivals in 4-L, 18-A, 21-I about early check-in" → units win (not arrivals_today)', () => {
  const s = a.parseAudience("message today's arrivals in 4-L, 18-A, 21-I about early check-in");
  return s.kind === 'units' && s.units.join(',') === '4-L,18-A,21-I';
});
check('header names the units, not "today\'s arrivals"', () => {
  const s = a.parseAudience('guests in 4-L, 18-A, and 21-I');
  const d = a.describeAudience(s, 3);
  return /guests in 4-L, 18-A, 21-I/.test(d) && /3 guests/.test(d) && !/today's arrivals/.test(d);
});
check('no regression: "today\'s arrivals" (no units) → arrivals_today', () => a.parseAudience("today's arrivals").kind === 'arrivals_today');
check('no regression: "everyone checking out tomorrow" → checkouts_tomorrow', () => a.parseAudience('everyone checking out tomorrow').kind === 'checkouts_tomorrow');
check('no regression: "current guests" → current_guests', () => a.parseAudience('current guests').kind === 'current_guests');

// ── (4) named-unit audience + mid-draft removal both filter ──────────────────
check('named-unit resolution + then "remove 18-A" → only the remaining named units', () => {
  // simulate the 3 named-unit members, then a removal edit
  const named = [
    { reservationId: 'r1', firstName: 'Isael', unit: '4-L', guestName: 'Isael' },
    { reservationId: 'r2', firstName: 'Stella', unit: '18-A', guestName: 'Stella' },
    { reservationId: 'r3', firstName: 'Madison', unit: '21-I', guestName: 'Madison' },
  ];
  const amend = a.parseRecipientEdit('remove 18-A', named);
  const left = a.applyRecipientRemovals(named, amend);
  return amend.removeUnits.join() === '18-A' && left.map(m => m.unit).sort().join(',') === '21-I,4-L';
});

setTimeout(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); }, 300);
