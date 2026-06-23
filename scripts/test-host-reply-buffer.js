// Regression test for the inquiry host-reply blind spot.
// The webhook used to DROP host-role messages before buffering (server.js:1873-1877),
// so the bot never saw what the host told the guest (e.g. "smoking OK on the patio").
// Run: node scripts/test-host-reply-buffer.js
'use strict';
const assert = require('assert');
const { pushConvoMsg, recentMsgsByConvo, buildThreadMessages } = require('../src/server');

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

const CONVO = 'test-convo-rebecka';

ok('a host turn buffered for a conversation is retrievable', () => {
  recentMsgsByConvo.delete(CONVO);
  pushConvoMsg(CONVO, 'guest', 'Is smoking allowed?');
  pushConvoMsg(CONVO, 'host', 'Smoking on the patio is totally fine.');
  const buf = recentMsgsByConvo.get(CONVO);
  assert.ok(Array.isArray(buf), 'buffer exists');
  assert.strictEqual(buf.length, 2, 'both turns buffered');
  assert.strictEqual(buf[1].sender_role, 'host', 'host turn recorded with host role');
});

ok('the buffered host reply SURVIVES into what the model sees', () => {
  const buf = recentMsgsByConvo.get(CONVO);
  const built = buildThreadMessages(buf, 'Great, can I book then?', 30);
  const seen = built.priorContext + '\n' + built.messages.map(m => m.content).join('\n');
  assert.ok(seen.includes('Smoking on the patio is totally fine.'),
    'model must see the host’s smoking-OK reply (it was previously dropped)');
});

ok('a host turn with no conversationId is a safe no-op', () => {
  const before = recentMsgsByConvo.size;
  pushConvoMsg(null, 'host', 'orphan message');
  pushConvoMsg('', 'host', 'orphan message');
  assert.strictEqual(recentMsgsByConvo.size, before, 'no buffer entry created without a conversationId');
});

console.log(`\n${pass} passed`);
