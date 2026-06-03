// Replay of the six guest messages from the night of 2026-06-02 (11pm–12am EDT),
// when the concierge email went out 44 minutes late because CONCIERGE_REGEX and
// the AI classifier both missed "Please call the front desk to confirm" and
// "Still waiting in lobby". This test runs each message through BOTH detectors
// and prints which now fire.
//
// Part A (regex) is deterministic and always runs — it pulls the LIVE regex out
// of src/server.js (same eval technique as test-concierge-regex.js), so it tests
// exactly what production uses. Hard requirements asserted:
//   - "Please call the front desk to confirm!" MUST hit
//   - "Still waiting in lobby"                 MUST hit
//   - "👍🏾" (a thumbs-up) MUST NOT hit
//
// Part B (classifier) calls the REAL Claude with the updated prompt, forcing the
// AI path (regexHit:false) so we see the classifier's own verdict. It runs only
// when ANTHROPIC_API_KEY is set; otherwise it is skipped with a notice.
//
// Run: node scripts/test-concierge-lastnight.js

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { classifyConcierge } = require('../src/concierge-classifier');

// Pull the live CONCIERGE_REGEX out of server.js (no copy — tests the real one).
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const m = src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/);
if (!m) { console.error('Could not locate CONCIERGE_REGEX in src/server.js'); process.exit(2); }
// eslint-disable-next-line no-eval
const CONCIERGE_REGEX = eval('new RegExp(' + m[1] + '\n)');
// Mirror the server's call sites: lowercase + normalize curly→straight apostrophes.
const regexHitFor = t => CONCIERGE_REGEX.test(String(t).toLowerCase().replace(/[’‘]/g, "'"));

// Last night's six messages, in order, with what we now expect of each.
//   expect: true  → a real front-desk contingency, should fire
//   expect: false → not a contingency, must stay silent
//   must:   true  → the user's hard requirement for this fix
const MESSAGES = [
  { text: '👍🏾',                                              expect: false },
  { text: "Hey what's the room number",                       expect: true  },
  { text: 'Update me in spreadsheet',                         expect: true  },
  { text: 'Please call the front desk to confirm!',           expect: true, must: true },
  { text: 'Still waiting in lobby',                           expect: true, must: true },
  { text: 'All i need you to do is confirm to the front desk', expect: true  },
];

(async () => {
  console.log('── PART A: CONCIERGE_REGEX (live from server.js, deterministic) ──\n');
  console.log(`  ${'REGEX'.padEnd(7)} ${'EXPECT'.padEnd(7)} message`);
  console.log('  ' + '─'.repeat(72));

  let fail = 0;
  for (const { text, expect, must } of MESSAGES) {
    const hit = regexHitFor(text);
    const ok = hit === expect;
    const mark = hit ? 'FIRE ' : 'silent';
    const flag = ok ? (must ? '✓*' : '✓ ') : '✗ ';
    console.log(`  ${flag} ${mark.padEnd(5)} ${String(expect).padEnd(7)} "${text}"`);
    if (!ok) fail++;
  }

  // Hard assertions (the reason this fix exists).
  console.log('\n  asserting hard requirements:');
  const assertHit = (t)  => { const h = regexHitFor(t); console.log(`   ${h ? '✓' : '✗'} regex fires on "${t}"`);        assert.ok(h,  `regex must fire on "${t}"`); };
  const assertMiss = (t) => { const h = regexHitFor(t); console.log(`   ${!h ? '✓' : '✗'} regex stays silent on "${t}"`); assert.ok(!h, `regex must NOT fire on "${t}"`); };
  try {
    assertHit('Please call the front desk to confirm!');
    assertHit('Still waiting in lobby');
    assertMiss('👍🏾');
  } catch (e) { console.error('   ✗', e.message); fail++; }

  // ── PART B: real Claude classifier with the updated prompt ──
  console.log('\n── PART B: AI classifier verdicts (real Claude, AI path forced) ──\n');
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see live AI verdicts)');
    console.log('  Note: in production these messages fire via the regex fast-path above regardless,');
    console.log('        so the must-hit cases are already covered without an AI call.\n');
  } else {
    // Real raw-fetch Claude call, mirroring server.js callClaude() / the classifier test.
    const realCallClaude = async (system, userMsg, maxTokens = 5) => {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-opus-4-8',
          max_tokens: maxTokens,
          system,
          messages: [{ role: 'user', content: userMsg }],
        }),
      });
      if (!r.ok) throw new Error(`Claude ${r.status}: ${await r.text()}`);
      const d = await r.json();
      return d.content?.[0]?.text || '';
    };

    console.log(`  ${'AI'.padEnd(7)} ${'EXPECT'.padEnd(7)} message`);
    console.log('  ' + '─'.repeat(72));
    for (const { text, expect } of MESSAGES) {
      // regexHit:false forces the AI path so we observe the classifier alone.
      const fired = await classifyConcierge(text, { regexHit: false, callClaude: realCallClaude, timeoutMs: 8000 });
      const ok = fired === expect;
      console.log(`  ${ok ? '✓ ' : '✗ '} ${(fired ? 'FIRE ' : 'silent').padEnd(5)} ${String(expect).padEnd(7)} "${text}"`);
      if (!ok) fail++;
    }
  }

  console.log(`\nRESULT: ${fail === 0 ? 'ALL PASS' : fail + ' FAILED'}  (* = user's hard requirement)`);
  process.exitCode = fail ? 1 : 0;
})();
