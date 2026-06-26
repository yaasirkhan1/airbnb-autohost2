'use strict';
const s = require('../src/opportunity-scanner');

let pass = 0, fail = 0;
const check = (n, fn) => { try { if (fn() === false) throw new Error('false'); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n} — ${e.message}`); fail++; } };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); return true; };

const TODAY = '2026-06-26', TOM = '2026-06-27';
const cal = (entries) => { const c = {}; for (const [d, a, p] of entries) c[d] = { available: a, price: p }; return c; };
const unit = (label, reservations, calendar) => ({ unit: label, propertyId: 'p_' + label, today: TODAY, tomorrow: TOM, reservations, calendar });

// fixtures
const u_ext = unit('21-I', [{ id: 'rNabil', guest: 'Nabil', firstName: 'Nabil', checkIn: '2026-06-24', checkOut: TOM }], cal([[TOM, true, 117]]));            // extension + late checkout
const u_turn = unit('18-A', [{ id: 'rOut', guest: 'Stella', firstName: 'Stella', checkIn: '2026-06-23', checkOut: TOM }, { id: 'rIn', guest: 'New', firstName: 'New', checkIn: TOM, checkOut: '2026-06-30' }], cal([[TOM, false, 0]])); // same-day turnover
const u_early = unit('4-L', [{ id: 'rIsael', guest: 'Isael', firstName: 'Isael', checkIn: TODAY, checkOut: '2026-06-29' }], cal([])); // arrival today, no checkout today
const u_earlyTurn = unit('7-B', [{ id: 'rO', guest: 'X', firstName: 'X', checkIn: '2026-06-20', checkOut: TODAY }, { id: 'rArr', guest: 'Y', firstName: 'Y', checkIn: TODAY, checkOut: '2026-06-28' }], cal([])); // arrival today BUT checkout today → not feasible
const u_gap = unit('23-N', [{ id: 'rG', guest: 'Gita', firstName: 'Gita', checkIn: '2026-06-27', checkOut: '2026-06-29' }],
  cal([['2026-06-28', false, 0], ['2026-06-29', true, 90], ['2026-06-30', false, 0]])); // orphan vacant night 06-29

// ── detectors ───────────────────────────────────────────────────────────────
check('EXTENSION fires: checkout tomorrow + vacant + no turnover', () => { const o = s.detectExtension(u_ext); return o && o.type === 'extension' && o.firstName === 'Nabil' && o.baseline.calendarPrice === 117; });
check('EXTENSION skipped on same-day turnover', () => s.detectExtension(u_turn) === null);
check('EXTENSION skipped when night not vacant', () => s.detectExtension(unit('9', [{ id: 'r', checkOut: TOM, firstName: 'A' }], cal([[TOM, false, 0]]))) === null);
check('LATE CHECKOUT fires for the same checkout guest (no arrival tomorrow)', () => { const o = s.detectLateCheckout(u_ext); return o && o.type === 'late_checkout' && o.firstName === 'Nabil'; });
check('LATE CHECKOUT skipped when someone arrives tomorrow', () => s.detectLateCheckout(u_turn) === null);
check('EARLY CHECK-IN fires: arrival today, no checkout today', () => { const o = s.detectEarlyCheckin(u_early); return o && o.type === 'early_checkin' && o.firstName === 'Isael'; });
check('EARLY CHECK-IN skipped on same-day turnover (cleaning)', () => s.detectEarlyCheckin(u_earlyTurn) === null);
check('GAP FILL finds the orphan vacant night, booked both sides', () => { const g = s.detectGapFill(u_gap); return g.length === 1 && g[0].dates.night === '2026-06-29' && g[0].baseline.calendarPrice === 90; });
check('GAP FILL does NOT fire on missing calendar data (unknown ≠ booked)', () => s.detectGapFill(u_ext).length === 0 && s.scanUnit(u_ext).every(o => o.type !== 'gap_fill'));

// ── pricing ──────────────────────────────────────────────────────────────────
check('extension price = calendar + vacancy markup', () => s.suggestPrice(s.detectExtension(u_ext), { vacantCount: 4 }) === 122 && s.suggestPrice(s.detectExtension(u_ext), { vacantCount: 1 }) === 127);
check('early/late = $45 flat', () => s.suggestPrice(s.detectEarlyCheckin(u_early)) === 45 && s.suggestPrice(s.detectLateCheckout(u_ext)) === 45);
check('gap fill = calendar price', () => s.suggestPrice(s.detectGapFill(u_gap)[0]) === 90);

// ── decision parser ────────────────────────────────────────────────────────────
check('parse "approve 1 2" → approve 1,2', () => { const o = s.parseDigestDecision('approve 1 2'); return o.filter(x => x.op === 'approve').map(x => x.n).join() === '1,2'; });
check('parse "1 at $85" → override 1 to 85', () => { const o = s.parseDigestDecision('1 at $85'); return o[0].op === 'override' && o[0].n === 1 && o[0].value === 85; });
check('parse "skip 3" → skip 3', () => { const o = s.parseDigestDecision('skip 3'); return o.some(x => x.op === 'skip' && x.n === 3); });
check('parse "approve all" → all', () => s.parseDigestDecision('approve all')[0].op === 'all');
check('parse "send" → send', () => s.parseDigestDecision('send')[0].op === 'send');
check('parse "2 to 60 and skip 4" → override 2→60 + skip 4', () => { const o = s.parseDigestDecision('2 to 60 and skip 4'); return o.some(x => x.op === 'override' && x.n === 2 && x.value === 60) && o.some(x => x.op === 'skip' && x.n === 4); });

// ── apply + sendable ───────────────────────────────────────────────────────────
check('override implies approval at the chosen price; skip excludes; send list is correct', () => {
  const items = s.buildDigestItems([s.detectExtension(u_ext), s.detectEarlyCheckin(u_early), s.detectLateCheckout(u_ext)], { vacantCount: 4 });
  let it = s.applyDecisions(items, s.parseDigestDecision('1 at $85'));   // override extension to 85
  it = s.applyDecisions(it, s.parseDigestDecision('skip 3'));            // skip the late-checkout dupe
  it = s.applyDecisions(it, s.parseDigestDecision('approve 2'));         // approve early check-in at suggested
  const send = s.approvedSendable(it);
  ok(send.length === 2, `2 sendable, got ${send.length}`);
  ok(send.find(x => x.type === 'extension').chosen === 85, 'extension chosen $85 (override)');
  ok(send.find(x => x.type === 'early_checkin').chosen === 45, 'early check-in $45 (suggested)');
  ok(!send.some(x => x.type === 'late_checkout'), 'skipped late checkout excluded');
  return true;
});

// ── same-guest stacking (don't double-message one guest) ─────────────────────
check('stacking detected: Nabil has extension + late checkout (same reservation)', () => {
  const items = s.buildDigestItems(s.scanUnit(u_ext), { vacantCount: 4 });
  const stacks = s.sameGuestStacks(items);
  return stacks.rNabil && stacks.rNabil.length === 2;
});
check('digest format flags the stack with "same guest as #"', () => {
  const items = s.buildDigestItems(s.scanUnit(u_ext), { vacantCount: 4 });
  const txt = s.formatDigest(items, TOM);
  return /same guest as #/.test(txt) && /multiple options/.test(txt);
});
check('sendable conflict: approving BOTH Nabil items is a same-guest conflict (blocks send)', () => {
  let items = s.buildDigestItems(s.scanUnit(u_ext), { vacantCount: 4 });
  items = s.applyDecisions(items, s.parseDigestDecision('approve 1 2'));
  const conflicts = s.sameGuestConflicts(items);
  return conflicts.length === 1 && conflicts[0].firstName === 'Nabil' && conflicts[0].items.join() === '1,2';
});
check('resolving the stack (skip one) clears the conflict', () => {
  let items = s.buildDigestItems(s.scanUnit(u_ext), { vacantCount: 4 });
  items = s.applyDecisions(items, s.parseDigestDecision('approve 1'));
  items = s.applyDecisions(items, s.parseDigestDecision('skip 2'));
  return s.sameGuestConflicts(items).length === 0 && s.approvedSendable(items).length === 1;
});

// ── printed END-TO-END SAMPLE so the flow is visible ─────────────────────────
console.log('\n──────── SAMPLE DIGEST (rendered) ────────');
const allOpps = [].concat(s.scanUnit(u_ext), s.scanUnit(u_early), s.scanUnit(u_turn), s.scanUnit(u_gap));
const items0 = s.buildDigestItems(allOpps, { vacantCount: 4 });
console.log(s.formatDigest(items0, TOM));
console.log('\n──────── host replies "1 at $85"  then  "skip 3"  then  "send" ────────');
let live = s.applyDecisions(items0, s.parseDigestDecision('1 at $85'));
console.log('\n' + s.formatDigest(live, TOM));
live = s.applyDecisions(live, s.parseDigestDecision('skip 3'));
const finalSend = s.approvedSendable(live);
console.log(`\n→ on "send", would message ${finalSend.length} guest(s): ` + finalSend.map(x => `${x.firstName}/${x.unit} $${x.chosen}`).join(', '));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
