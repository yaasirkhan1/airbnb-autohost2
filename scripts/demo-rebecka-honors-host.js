// Live before/after demo (NOT a unit test — calls the real model; needs ANTHROPIC_API_KEY).
// Shows the model honoring the host's "smoking OK on patio" reply instead of reciting the
// stored "no smoking" house rule. Run: node scripts/demo-rebecka-honors-host.js
'use strict';
process.env.HOUSE_RULES = process.env.HOUSE_RULES || 'No smoking anywhere, no parties, quiet hours after 10pm.';
const { draftReply, pushConvoMsg, recentMsgsByConvo } = require('../src/server');

(async () => {
  const CONVO = 'rebecka-demo';

  // BEFORE: no host reply buffered (simulates the old dropped-webhook behavior).
  recentMsgsByConvo.delete(CONVO);
  pushConvoMsg(CONVO, 'guest', 'Is smoking allowed during my stay?');
  const before = await draftReply('Rebecka', 'Is smoking allowed during my stay?', 'Unit 7-B', null,
    false, null, 'inquiry', CONVO);
  console.log('\n=== BEFORE (host reply NOT seen) ===\n', before.reply);

  // AFTER: host's in-app reply buffered (the fixed behavior).
  recentMsgsByConvo.delete(CONVO);
  pushConvoMsg(CONVO, 'guest', 'Is smoking allowed during my stay?');
  pushConvoMsg(CONVO, 'host', 'Smoking is fine on the patio — just not inside the unit. – Cal');
  const after = await draftReply('Rebecka', 'Great — so where exactly can I smoke?', 'Unit 7-B', null,
    false, null, 'inquiry', CONVO);
  console.log('\n=== AFTER (host reply seen + authority directive) ===\n', after.reply);
  console.log('\nExpect AFTER to permit smoking on the patio, NOT say "no smoking anywhere".');
})().catch(e => { console.error(e); process.exit(1); });
