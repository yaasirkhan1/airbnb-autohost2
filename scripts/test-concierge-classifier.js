// TDD for Strategy B — AI intent detection for the front-desk contingency.
//
// The classifier decides ONE thing: does the guest's message mean
// "the front desk / concierge can't check me in because they don't have my
//  reservation/form, and the host needs to send it"?
//   - MUST fire on real cases (Dekarius fragments, Kedravious question)
//   - MUST stay SILENT on innocent front-desk mentions
//
// Trust requirements baked into these tests:
//   (fast-path)  if CONCIERGE_REGEX already matches, fire WITHOUT calling AI.
//   (fallback)   if the AI call throws or times out, fall back to the regex
//                result — a classifier error must NEVER drop a guest.
//   (tight)      a strict YES/NO parse; anything not YES is silent.
//
// Part A runs offline with a mocked Claude (deterministic — always run).
// Part B calls the REAL Claude over every named case and PRINTS each decision
// (this is the "show me the decisions before deploy" output). It runs only
// when ANTHROPIC_API_KEY is set; otherwise it is skipped with a notice.
//
// Run: node scripts/test-concierge-classifier.js

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  classifyConcierge,
  parseVerdict,
  CLASSIFIER_SYSTEM_PROMPT,
} = require('../src/concierge-classifier');

// Pull the live CONCIERGE_REGEX out of server.js (same technique as the
// window test) so the fast-path test uses the real production regex.
const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
const CONCIERGE_REGEX = eval('new RegExp(' + src.match(/const CONCIERGE_REGEX = new RegExp\(([\s\S]*?)\n\);/)[1] + '\n)');
const regexHitFor = t => CONCIERGE_REGEX.test(String(t).toLowerCase().replace(/[’‘]/g, "'"));

let pass = 0, fail = 0;
const check = async (n, f) => {
  try { await f(); console.log('✓', n); pass++; }
  catch (e) { console.log('✗', n, '\n   ', e.message); fail++; }
};

// ── Real + innocent cases (the ones the user named) ─────────────────────────
const FIRE_CASES = [
  ['Dekarius fragments (joined)', 'Can you send reservation To the front desk Or call'],
  ['Kedravious question',         'Did you guys send my informations over to concierge desk?'],
  // Paraphrased variants — prove the AI catches contingencies the regex misses.
  ['paraphrase: no record, no key', "the lady downstairs says she has nothing under my name and won't give me a key"],
  ['paraphrase: nothing on file',   'front desk has no booking for me, can you let them know im checked in'],
];
const SILENT_CASES = [
  ['where is the front desk?',        'where is the front desk?'],
  ['is the front desk open 24h?',     'is the front desk open 24h?'],
  ['can you send wifi info?',         'can you send wifi info?'],
];

(async () => {
  console.log('── PART A: classifier logic (mocked Claude, deterministic) ──\n');

  // parseVerdict is strict: only an affirmative YES fires.
  await check('parseVerdict: YES → true, NO → false, junk → false', () => {
    assert.strictEqual(parseVerdict('YES'), true);
    assert.strictEqual(parseVerdict(' yes.\n'), true);
    assert.strictEqual(parseVerdict('NO'), false);
    assert.strictEqual(parseVerdict('No, this looks innocent'), false);
    assert.strictEqual(parseVerdict(''), false);
    assert.strictEqual(parseVerdict('maybe'), false);
  });

  // fast-path: a regex hit fires immediately and must NOT spend an AI call.
  await check('fast-path: regexHit=true → true WITHOUT calling Claude', async () => {
    let called = false;
    const out = await classifyConcierge('whatever', {
      regexHit: true,
      callClaude: async () => { called = true; return 'NO'; },
    });
    assert.strictEqual(out, true);
    assert.strictEqual(called, false, 'AI must not be called on a regex fast-path');
  });

  // AI decides when regex misses.
  await check('AI path: regex miss + Claude says YES → true', async () => {
    const out = await classifyConcierge('did you send my info to the desk', {
      regexHit: false, callClaude: async () => 'YES',
    });
    assert.strictEqual(out, true);
  });
  await check('AI path: regex miss + Claude says NO → false', async () => {
    const out = await classifyConcierge('where is the front desk', {
      regexHit: false, callClaude: async () => 'NO',
    });
    assert.strictEqual(out, false);
  });

  // fallback: a thrown error must fall back to the regex result, never drop.
  await check('fallback: Claude throws + regexHit=true → true (never dropped)', async () => {
    const out = await classifyConcierge('x', {
      regexHit: true, callClaude: async () => { throw new Error('500'); },
    });
    assert.strictEqual(out, true);
  });
  await check('fallback: Claude throws + regexHit=false → false (regex-only behavior)', async () => {
    const out = await classifyConcierge('x', {
      regexHit: false, callClaude: async () => { throw new Error('500'); },
    });
    assert.strictEqual(out, false);
  });

  // timeout: a hung AI call must resolve to the regex result within the budget.
  await check('timeout: Claude hangs → falls back to regexHit within budget', async () => {
    const start = Date.now();
    const out = await classifyConcierge('x', {
      regexHit: true,
      timeoutMs: 150,
      callClaude: () => new Promise(() => {}), // never resolves
    });
    assert.strictEqual(out, true);
    assert.ok(Date.now() - start < 1000, 'must not hang past the timeout');
  });

  console.log('\n── PART B: real Claude decisions on every named case ──\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see live decisions)\n');
  } else {
    // Real raw-fetch Claude call, mirroring server.js callClaude().
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
    // Force the AI path (regexHit:false) so we observe the classifier itself,
    // not the regex fast-path — proves the AI alone gets these right.
    const decide = (text) =>
      classifyConcierge(text, { regexHit: false, callClaude: realCallClaude, timeoutMs: 8000 });

    for (const [label, text] of FIRE_CASES) {
      await check(`FIRE: ${label}`, async () => {
        const regexAlone = regexHitFor(text);
        const aiFires = await decide(text);
        console.log(`     regex-alone=${regexAlone ? 'HIT ' : 'miss'}  AI=${aiFires ? 'FIRE  ' : 'SILENT'}  ← "${text}"`);
        assert.ok(aiFires, 'classifier should FIRE on this real case');
      });
    }
    for (const [label, text] of SILENT_CASES) {
      await check(`SILENT: ${label}`, async () => {
        const regexAlone = regexHitFor(text);
        const aiFires = await decide(text);
        console.log(`     regex-alone=${regexAlone ? 'HIT ' : 'miss'}  AI=${aiFires ? 'FIRE  ' : 'SILENT'}  ← "${text}"`);
        assert.ok(!aiFires, 'classifier should stay SILENT on this innocent case');
      });
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0; // set code without truncating buffered stdout
})();
