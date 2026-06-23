// The Rebecka case, deterministic: with the host's "smoking OK on patio" reply buffered and
// HOUSE_RULES = "no smoking", the assembled draftReply prompt must contain BOTH the host's
// statement AND the host-authority directive — so the model is told to honor the host, not
// recite "no smoking". Captures the prompt via an injected callClaude (no network call).
// Run: node scripts/test-rebecka-prompt.js
'use strict';
process.env.HOUSE_RULES = 'No smoking anywhere, no parties, quiet hours after 10pm.';
const assert = require('assert');
const { draftReply, pushConvoMsg, recentMsgsByConvo, HOST_AUTHORITY_DIRECTIVE } = require('../src/server');

let pass = 0;
const ok = (n, f) => f().then(() => { console.log('✓', n); pass++; });

const CONVO = 'rebecka-convo-1';

(async () => {
  // Seed the buffer exactly as the fixed webhook would: guest asked, host answered in-app.
  recentMsgsByConvo.delete(CONVO);
  pushConvoMsg(CONVO, 'guest', 'Hi! Is smoking allowed during my stay?');
  pushConvoMsg(CONVO, 'host', 'Smoking is fine on the patio — just not inside the unit. – Cal');

  let captured = null;
  const fakeCallClaude = async (systemBlocks, promptInput) => {
    captured = { systemBlocks, promptInput };
    return JSON.stringify({ confident: true, reply: 'Yes — smoking is fine on the patio.' });
  };

  // resourceType 'inquiry' + conversationId → draftReply reads the in-memory buffer.
  await draftReply('Rebecka', 'Great — so where can I smoke?', 'Unit 7-B', null,
    false, null, 'inquiry', CONVO, { callClaude: fakeCallClaude });

  await ok('callClaude was invoked and the prompt captured', async () => {
    assert.ok(captured, 'fake callClaude ran');
  });

  const sysText = captured.systemBlocks.map(b => (typeof b === 'string' ? b : b.text)).join('\n');
  const msgText = Array.isArray(captured.promptInput)
    ? captured.promptInput.map(m => (typeof m.content === 'string' ? m.content
        : (m.content || []).map(c => c.text || '').join(' '))).join('\n')
    : String(captured.promptInput);
  const everything = sysText + '\n' + msgText;

  await ok('the stored "no smoking" house rule is present (the conflicting fact)', async () => {
    assert.ok(sysText.toLowerCase().includes('no smoking'), 'HOUSE_RULES still in the prompt');
  });

  await ok('AFTER: the host’s smoking-OK reply is in the assembled prompt', async () => {
    assert.ok(everything.includes('Smoking is fine on the patio'),
      'the host reply the bot used to never see is now in the prompt');
  });

  await ok('AFTER: the host-authority directive is in the assembled prompt', async () => {
    assert.ok(sysText.includes(HOST_AUTHORITY_DIRECTIVE),
      'directive instructs the model to follow the host over the stored rule');
  });

  console.log(`\n${pass} passed`);
  if (pass < 4) process.exit(1);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
