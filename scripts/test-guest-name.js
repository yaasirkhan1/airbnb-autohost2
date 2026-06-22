'use strict';
// Tests for safe guest greeting-name resolution. Run: node scripts/test-guest-name.js
// Guards the "greet guest Jamie as host Yaasir on an inquiry" bug: never address a guest by the
// host/account name; prefer the real guest object; otherwise a neutral no-name greeting.
const assert = require('assert');
const gn = require('../src/guest-name');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

// The reported scenario: an INQUIRY whose message sender.full_name is the HOST/account name.
const HOST = 'Yaasir';
const hostSenderMsg = { sender_role: 'guest', sender: { full_name: 'Yaasir' } }; // guest-role, but sender carries the host name (the bug)
const hostNamesEnvOnly = gn.hostNameSet({ hostEnvName: HOST });

check('firstToken: first name only; blank/missing → ""', () => {
  assert.strictEqual(gn.firstToken('Jamie Smith'), 'Jamie');
  assert.strictEqual(gn.firstToken('  Jamie  '), 'Jamie');
  assert.strictEqual(gn.firstToken(''), '');
  assert.strictEqual(gn.firstToken(null), '');
  assert.strictEqual(gn.firstToken(undefined), '');
});

check('hostNameSet: collects HOST_NAME + host-role sender names from the thread', () => {
  const thread = [
    { sender_role: 'guest', sender: { full_name: 'Jamie Lee' } },
    { sender_role: 'host', sender: { full_name: 'Yaasir Khan' } },
    { sender_type: 'co-host', sender: { first_name: 'Casey' } },
  ];
  const hosts = gn.hostNameSet({ hostEnvName: 'KS', messages: thread });
  assert.ok(hosts.has('ks') && hosts.has('yaasir') && hosts.has('casey'), [...hosts].join(','));
  assert.ok(!hosts.has('jamie'), 'guest name must NOT be in the host set');
});

check('INQUIRY, sender is the host name, GUEST OBJECT available → uses the guest\'s real name (Jamie)', () => {
  const name = gn.resolveGuestName({
    guest: { first_name: 'Jamie' },
    senderName: hostSenderMsg.sender.full_name,   // 'Yaasir' (host)
    hostNames: hostNamesEnvOnly,
  });
  assert.strictEqual(name, 'Jamie');
});

check('INQUIRY, sender is the host name, NO guest object → neutral null, NEVER the host name', () => {
  const name = gn.resolveGuestName({
    guest: null,
    senderName: 'Yaasir',
    hostNames: hostNamesEnvOnly,
  });
  assert.strictEqual(name, null, 'must be null (caller greets "Hi there"), never "Yaasir"');
  assert.notStrictEqual(name, 'Yaasir');
});

check('host detection is case-insensitive and ignores extra tokens', () => {
  const hosts = gn.hostNameSet({ hostEnvName: 'yaasir' });
  assert.strictEqual(gn.resolveGuestName({ guest: null, senderName: 'YAASIR KHAN', hostNames: hosts }), null);
});

check('CONFIRMED RESERVATION → greets with the correct guest first name', () => {
  const name = gn.resolveGuestName({
    guest: { first_name: 'Dana', name: 'Dana Wells' },
    senderName: 'Dana Wells',
    hostNames: hostNamesEnvOnly,
  });
  assert.strictEqual(name, 'Dana');
});

check('NORMAL inquiry with a real guest sender name (no guest object) → uses the sender name', () => {
  const name = gn.resolveGuestName({
    guest: null,
    senderName: 'Priya Nair',
    hostNames: hostNamesEnvOnly,   // host = Yaasir; Priya is not the host → allowed
  });
  assert.strictEqual(name, 'Priya');
});

check('guest object falls back to `name` when first_name absent', () => {
  assert.strictEqual(gn.resolveGuestName({ guest: { name: 'Sam Ortiz' }, senderName: null, hostNames: hostNamesEnvOnly }), 'Sam');
});

check('thread-derived host name (no HOST_NAME env) still rejects a host sender name', () => {
  const thread = [{ sender_role: 'host', sender: { full_name: 'Yaasir Khan' } }];
  const hosts = gn.hostNameSet({ messages: thread });   // hostEnvName undefined
  assert.strictEqual(gn.resolveGuestName({ guest: null, senderName: 'Yaasir', hostNames: hosts }), null);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
