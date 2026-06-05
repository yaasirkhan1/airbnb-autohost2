// Regression test for the "leading host turns dropped" bug.
//
// Root cause: buildThreadMessages must return a user-first array (Anthropic rule),
// so it stripped leading host (assistant) turns — which is exactly where the
// check-in details we already sent (door code, Wi-Fi, access) live. The model then
// had no idea check-in info was sent and promised it as "coming soon".
//
// Fixture = the REAL Eshia Brown thread (7-B, reservation dd64f61f) that exposed it.
// Run: node scripts/test-thread-leading-host.js
'use strict';
const assert = require('assert');
const { buildThreadMessages, checkinAlreadySent } = require('../src/server');

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

// Real thread, chronological (sender_role + body + created_at), as pulled from Hospitable.
const ESHIA_THREAD = [
  { sender_role: 'host',  created_at: '2026-05-01T18:52:33Z',
    body: 'Hey Eshia Your booking is confirmed – we’re excited to host you! Check-in: Friday, June 5 @ 3:00 PM. Check-in details will be shared 24 hours before arrival. Best, Z' },
  { sender_role: 'host',  created_at: '2026-06-04T19:00:35Z',
    body: 'Hi Eshia, Here are the details for your stay: Address: 300 Peachtree Street Northeast, Atlanta, GA, 30308. Wi-Fi: ARRIS-4A75-5G | Password: 3G53 4410 1127. Door Code: 4806. Access Instructions: When you arrive to the building, check in with front desk to register.' },
  { sender_role: 'host',  created_at: '2026-06-05T19:00:31Z',
    body: 'We encountered an issue while setting your code on the lock. No need to worry! Please use this code instead: 7497' },
  { sender_role: 'guest', created_at: '2026-06-05T19:01:23Z', body: 'Okay Thank you !' },
  { sender_role: 'host',  created_at: '2026-06-05T19:02:06Z',
    body: "You're very welcome, Eshia! If anything else comes up before or during your stay, please don't hesitate to reach out." },
  { sender_role: 'guest', created_at: '2026-06-05T19:03:40Z', body: 'I sure will !!' },
];

// "What the model sees" = the system-prompt priorContext PLUS the messages array text.
const whatModelSees = (built) =>
  built.priorContext + '\n' + built.messages.map(m => m.content).join('\n');

ok('returns { messages, priorContext } and the array is user-first', () => {
  const built = buildThreadMessages(ESHIA_THREAD, 'I sure will !!', 12);
  assert.ok(Array.isArray(built.messages), 'messages is an array');
  assert.strictEqual(typeof built.priorContext, 'string', 'priorContext is a string');
  assert.ok(built.messages.length > 0, 'messages not empty');
  assert.strictEqual(built.messages[0].role, 'user', 'Anthropic user-first rule preserved');
});

ok('check-in details SURVIVE into what the model sees (the bug fix)', () => {
  const built = buildThreadMessages(ESHIA_THREAD, 'I sure will !!', 12);
  const seen = whatModelSees(built);
  for (const marker of ['Door Code', '4806', 'Wi-Fi', 'ARRIS-4A75-5G', 'Access Instructions']) {
    assert.ok(seen.includes(marker), `model must see "${marker}" — it was previously dropped`);
  }
  // The check-in details specifically land in priorContext (folded into the system
  // prompt), not silently deleted as before.
  assert.ok(built.priorContext.includes('Door Code: 4806'), 'door code preserved in priorContext');
  assert.ok(built.priorContext.includes('ARRIS-4A75-5G'), 'wifi preserved in priorContext');
});

ok('OLD behavior would have LOST it: leading host content is NOT in the messages array', () => {
  // Proves the relocation — the check-in details are no longer riding as a leading
  // assistant turn (which the old code shifted into oblivion); they moved to context.
  const built = buildThreadMessages(ESHIA_THREAD, 'I sure will !!', 12);
  const msgText = built.messages.map(m => m.content).join('\n');
  assert.ok(!msgText.includes('Door Code: 4806'),
    'check-in details should be in priorContext (system prompt), not the messages array');
});

ok('checkinAlreadySent detects host-sent check-in markers in this thread', () => {
  assert.strictEqual(checkinAlreadySent(ESHIA_THREAD), true);
});

ok('checkinAlreadySent is false when no check-in info was ever sent', () => {
  const plain = [
    { sender_role: 'guest', created_at: '2026-06-01T10:00:00Z', body: 'Hi! Looking forward to the stay.' },
    { sender_role: 'host',  created_at: '2026-06-01T10:05:00Z', body: 'So glad to have you — let us know if you need anything!' },
  ];
  assert.strictEqual(checkinAlreadySent(plain), false);
});

ok('thread already starting with a guest turn → empty priorContext, user-first intact', () => {
  const guestFirst = [
    { sender_role: 'guest', created_at: '2026-06-01T10:00:00Z', body: 'What time is check-in?' },
    { sender_role: 'host',  created_at: '2026-06-01T10:05:00Z', body: 'Check-in is 3 PM.' },
  ];
  const built = buildThreadMessages(guestFirst, 'And parking?', 12);
  assert.strictEqual(built.priorContext, '', 'no leading host turns → no priorContext');
  assert.strictEqual(built.messages[0].role, 'user');
});

console.log(`\n${pass}/${pass} passed`);
