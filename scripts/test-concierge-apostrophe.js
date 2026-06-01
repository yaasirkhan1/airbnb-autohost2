// Proves the access/front-desk patterns in CONCIERGE_REGEX match phone-typed
// (curly ’ / U+2019) apostrophes, not just straight ' apostrophes.
// Run: node scripts/test-concierge-apostrophe.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const m = src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/);
assert.ok(m, 'could not locate CONCIERGE_REGEX');
const CONCIERGE_REGEX = eval('new RegExp(' + m[1] + '\n)');

// Phone-typed (curly apostrophe) access messages — these all use U+2019 (’),
// which is what iOS/Android keyboards autoinsert. They MUST fire the contingency.
const CURLY_SHOULD_FIRE = [
  'they won’t let me in',
  'I can’t get in to the building',
  'security won’t let me come up',
  'they won’t buzz me up',
  'the front desk doesn’t have my reservation',
];
// Straight-apostrophe equivalents must still fire (no regression).
const STRAIGHT_SHOULD_FIRE = [
  "they won't let me in",
  "I can't get in to the building",
];
const SHOULD_NOT_FIRE = [
  'what time is checkout?',
  'what’s the wifi password?',   // curly, but not an access problem
];

let fail = 0;
const run = (label, list, want) => {
  console.log(`=== ${label} ===`);
  for (const s of list) {
    const hit = CONCIERGE_REGEX.test(s.toLowerCase());
    const ok = hit === want;
    console.log(`${ok ? '✓' : '✗'} ${hit ? 'fires ' : 'ignored'} ${JSON.stringify(s)}`);
    if (!ok) fail++;
  }
};
run('CURLY apostrophes SHOULD FIRE', CURLY_SHOULD_FIRE, true);
run('STRAIGHT apostrophes SHOULD FIRE (regression)', STRAIGHT_SHOULD_FIRE, true);
run('SHOULD NOT FIRE', SHOULD_NOT_FIRE, false);

const total = CURLY_SHOULD_FIRE.length + STRAIGHT_SHOULD_FIRE.length + SHOULD_NOT_FIRE.length;
console.log(`\nRESULT: ${total - fail}/${total} passed`);
process.exit(fail ? 1 : 0);
