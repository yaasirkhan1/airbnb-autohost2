// Draft-reply parsing: valid JSON, prose-only recovery, and empty/refusal escalation.
// Run: node scripts/test-draft-parse.js
const assert = require('assert');
const { parseDraftReply } = require('../src/draft-parse');

let pass = 0; const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// (a) valid JSON envelope → used as-is
ok('(a) valid JSON reply → confident, reply extracted', () => {
  const r = parseDraftReply('{"confident":true,"reply":"Sure — checkout is 11 AM."}');
  assert.strictEqual(r.confident, true);
  assert.strictEqual(r.reply, 'Sure — checkout is 11 AM.');
  assert.strictEqual(r.source, 'json');
});
ok('(a2) JSON with reasoning text around it still parses', () => {
  const r = parseDraftReply('Let me think...\n{"confident":true,"reply":"Hello!"}\nthanks');
  assert.strictEqual(r.reply, 'Hello!');
  assert.strictEqual(r.confident, true);
});
ok('(a3) JSON confident:false / empty reply → escalates', () => {
  assert.deepStrictEqual(parseDraftReply('{"confident":false,"reply":""}'), { reply: null, confident: false, source: 'json' });
});

// (b) prose-only (the prod bug) → recovered as the reply, confident
ok('(b) prose-only reply now recovered (not dropped)', () => {
  const raw = 'Hi Mekhi, yes — a 2-hour late checkout is available for $45. Want me to set it up?';
  const r = parseDraftReply(raw);
  assert.strictEqual(r.confident, true);
  assert.strictEqual(r.reply, raw);
  assert.strictEqual(r.source, 'prose-fallback');
});
ok('(b2) prose that merely opens with an apology is NOT treated as refusal', () => {
  const raw = "I'm sorry for the wait! The WiFi name is PeachtreeGuest and the password is welcome2026.";
  const r = parseDraftReply(raw);
  assert.strictEqual(r.confident, true);
  assert.strictEqual(r.reply, raw);
});

// (c) empty / refusal → still escalates
ok('(c) empty/whitespace prose → escalates', () => {
  assert.deepStrictEqual(parseDraftReply('   '), { reply: null, confident: false, source: 'empty-or-refusal' });
  assert.deepStrictEqual(parseDraftReply(''), { reply: null, confident: false, source: 'empty-or-refusal' });
});
ok('(c2) refusal prose → escalates', () => {
  const r = parseDraftReply("I'm sorry, I can't help with that.");
  assert.strictEqual(r.confident, false);
  assert.strictEqual(r.reply, null);
  assert.strictEqual(r.source, 'empty-or-refusal');
});
ok('(c3) malformed JSON (has { but unparseable) → escalates, never ships garbage', () => {
  const r = parseDraftReply('{"confident": true, "reply": "Hi"');  // truncated
  assert.strictEqual(r.confident, false);
  assert.strictEqual(r.reply, null);
  assert.strictEqual(r.source, 'malformed-json');
});

console.log(`\n${pass} passed`);
