// Full-thread context + de-escalation (feat/full-thread-deescalation).
//
// Part A (deterministic):
//   - long thread (> cap) retains its OPENING context via olderSummary, not silently dropped
//   - an inquiry-style buffer (guest + host turns) becomes a two-sided chronological thread
//   - isFrustrated flags an upset guest; routine msg is not flagged; the money boundary
//     (isMoneyComplaint) is intact for a refund complaint
//
// Part B (real Claude, sampled N times):
//   - a frustrated NON-money complaint → an acknowledging, de-escalating reply (not flat/canned,
//     not defensive)
//   - a money/refund complaint → the bot makes NO refund promise (the de-escalation money boundary)
//
// Run: node scripts/test-full-thread-deescalation.js
'use strict';
const assert = require('assert');
const { buildThreadMessages, isFrustrated, isMoneyComplaint, draftReply, summarizeOlderTurns } = require('../src/server');

let fail = 0;
const ok = (cond, msg) => { console.log(`  ${cond ? '✓' : '✗'} ${msg}`); if (!cond) fail++; };

(async () => {
  console.log('── PART A: thread context + sentiment (deterministic) ──\n');

  // (1) Long thread: 40 turns, opening turn carries a unique token. cap 30 → first 10 condensed.
  console.log(' long thread retains opening context:');
  const longThread = [];
  for (let i = 0; i < 40; i++) {
    longThread.push({
      body: i === 0 ? 'OPENINGTOPIC_ALPACA — I booked for the trade show and asked about early check-in.' : `turn ${i} message body`,
      sender_role: i % 2 === 0 ? 'guest' : 'host',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    });
  }
  const built = buildThreadMessages(longThread, 'turn 39 message body', 30);
  ok(built.olderSummary.includes('OPENINGTOPIC_ALPACA'), 'olderSummary preserves the opening turn (not dropped)');
  ok(built.messages.length <= 30, `kept window capped (${built.messages.length} merged turns ≤ 30)`);
  ok(!built.messages.some(m => m.content.includes('OPENINGTOPIC_ALPACA')), 'opening turn is condensed into the summary, not in the live window');
  ok(summarizeOlderTurns([]) === '', 'empty older set → empty summary (short threads add nothing)');

  // (2) Inquiry-style buffer (guest + host turns) → two-sided chronological thread.
  console.log('\n inquiry buffer becomes a two-sided thread:');
  const inquiryBuf = [
    { body: 'Hi, is this place close to AmericasMart?', sender_role: 'guest', created_at: '2026-06-13T10:00:00Z' },
    { body: 'Yes! It’s about a 3-minute walk — right in the district.', sender_role: 'host', created_at: '2026-06-13T10:02:00Z' },
    { body: 'Great. And is parking easy?', sender_role: 'guest', created_at: '2026-06-13T10:05:00Z' },
  ];
  const inq = buildThreadMessages(inquiryBuf, 'Great. And is parking easy?', 30);
  ok(inq.messages.some(m => m.role === 'assistant' && /3-minute walk/.test(m.content)), 'the bot’s earlier inquiry reply is present as an assistant turn (model sees what it already told the prospect)');
  ok(inq.messages[inq.messages.length - 1].role === 'user', 'thread ends on the latest guest turn');

  // (3) Sentiment + money boundary.
  console.log('\n frustration detection + money boundary:');
  ok(isFrustrated('This is absolutely unacceptable — the unit was filthy and I am extremely disappointed.') === true, 'flags an upset/complaining guest');
  ok(isFrustrated('Hi! What time is check-in tomorrow?') === false, 'does NOT flag a routine question');
  ok(isMoneyComplaint('The unit was dirty and not as listed — I want a partial refund.') === true, 'money/refund complaint still hits isMoneyComplaint (escalation boundary intact)');

  // ── PART B: LLM behavior, sampled ──
  console.log('\n── PART B: de-escalation reply behavior (real Claude), sampled ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to sample the live replies)');
    console.log(`\nRESULT: ${fail === 0 ? 'PART A ALL PASS' : fail + ' FAILED'}`);
    process.exitCode = fail ? 1 : 0;
    return;
  }

  const N = 3;
  const FRUSTRATED = 'I am beyond frustrated. The AC has been broken for two days, nobody has come to fix it, and it’s ruining our trip. This is unacceptable.';
  const ACK_RE = /\b(sorry|apolog\w+|understand|that'?s not (okay|right|acceptable)|frustrat\w+|shouldn'?t have|let me|i'?ll|on it|make (this|it) right|get (this|that) (sorted|fixed))\b/i;
  const DEFENSIVE_RE = /\b(policy (says|states)|not our fault|nothing (i|we) can do|per our|you (should have|didn'?t|failed)|that'?s not our)\b/i;

  console.log(' frustrated NON-money complaint → acknowledging, not defensive:');
  for (let i = 0; i < N; i++) {
    const r = await draftReply('Dana', FRUSTRATED, 'Apt 4-L', null, false, null, 'reservation');
    const reply = (r && r.reply) || '';
    console.log(`   [${i + 1}] ${reply.replace(/\n+/g, ' ').slice(0, 150)}`);
    ok(reply.trim().length > 0 && r.confident === true, `[${i + 1}] confident, non-empty reply`);
    ok(ACK_RE.test(reply), `[${i + 1}] leads with a genuine acknowledgement`);
    ok(!DEFENSIVE_RE.test(reply), `[${i + 1}] not defensive`);
  }

  console.log('\n money/refund complaint → bot makes NO refund promise (de-escalation boundary):');
  const MONEY = 'The unit was filthy and not what I booked. I want a refund for this stay.';
  const REFUND_PROMISE_RE = /\b(we'?ll refund|i'?ll refund|refund (you|is|has been|will be|approved|issued|processed)|you'?ll (get|be) .*(refund|back)|process (a|your) refund|\$\d)\b/i;
  for (let i = 0; i < N; i++) {
    const r = await draftReply('Dana', MONEY, 'Apt 4-L', null, false, null, 'reservation');
    const reply = (r && r.reply) || '';
    console.log(`   [${i + 1}] ${reply.replace(/\n+/g, ' ').slice(0, 150)}`);
    ok(!REFUND_PROMISE_RE.test(reply), `[${i + 1}] makes no refund amount/promise`);
  }

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}`);
  process.exitCode = fail ? 1 : 0;
})();
