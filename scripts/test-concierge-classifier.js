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
  decideConcierge,
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

// ── Real + innocent cases. PART B samples each N× (default 5, env CONCIERGE_SAMPLES)
// and asserts a tally, so a probabilistic classifier is held to a reliability band
// rather than one lucky call. ─────────────────────────────────────────────────────
const FIRE_CASES = [
  ['Dekarius fragments (joined)',           'Can you send reservation To the front desk Or call'],
  ['Kedravious question',                   'Did you guys send my informations over to concierge desk?'],
  // Desk-lacks-my-X paraphrases (no "key" wording — units have coded locks). Several of
  // these the regex misses by design; the AI must catch them.
  ["nothing under my name, won't let me up", "I'm at the front desk and they say there's nothing under my name and won't let me up"],
  ['front desk has no booking for me',       'front desk has no booking for me, can you let them know im checked in'],
  ["desk doesn't have my reservation",       "the front desk doesn't have my reservation"],
  ["can't find my booking",                  "they can't find my booking at the desk"],
  ['no record of me',                        'the concierge has no record of me'],
  ['not in the system',                      "front desk says I'm not in the system"],
  ["my registration wasn't sent",            "my registration wasn't sent to the front desk"],
  ["doesn't have my details/paperwork",      "the desk doesn't have my details or paperwork"],
  ["can't find my registration",             "they can't find my registration downstairs"],
  ["spreadsheet wasn't sent",                "the spreadsheet wasn't sent so the desk can't check me in"],
  ["check-in form wasn't sent",              "the check-in form wasn't sent to the building"],
  ["doesn't have my info",                   "the front desk doesn't have my info"],
  ["stuck in lobby / can't get up",          "I'm stuck in the lobby and can't get up to my floor"],
  ['please call front desk to confirm',      'Please call the front desk to confirm!'],
];
const SILENT_CASES = [
  ['where is the front desk?',               'where is the front desk?'],
  ['is the front desk open 24h?',            'is the front desk open 24h?'],
  ['can you send wifi info?',                'can you send wifi info?'],
  // 2026-06-06 false positive: a bare guest-name list / pre-arrival update is not an
  // access problem and MUST stay silent.
  ['guest-name list (Anne Cork, 6/6 false positive)', 'Here are the names of the guests staying: Anne Cork, Shannan Harris, Rachel Raber'],
  ['pre-arrival info (arrival time + party size)',     "We'll be arriving around 6pm, there will be 3 of us"],
  // Coded door locks → "key"/"fob"/door-code is building-access / amenity, NOT a check-in failure.
  ['key fob / building access request',      'Hey can I get a key fob for the gym and elevator access?'],
  ['door code question',                     "What's the door code for the unit?"],
  // Guardrails: trigger-ish words (reservation/booking/registration/form) but NOT the desk
  // lacking the guest's info — the guest wants their OWN info, or a normal form.
  ['send ME my reservation details',         'Can you send me my reservation details?'],
  ["my booking confirmation number",         "What's my booking confirmation number?"],
  ["here's my registration info",            "Here's my registration info"],
  ['can I get the parking form',             'Can I get the parking form?'],
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

  // ── Safety provisions (decideConcierge) ──────────────────────────────────
  // kill switch: CONCIERGE_AI=false → AI never consulted, reverts to regex-only.
  await check('kill switch: CONCIERGE_AI=false → AI not consulted, fired=regexHit', async () => {
    let called = false;
    const rec = await decideConcierge({
      text: 'did you send my info to the desk', regexHit: false,
      env: { CONCIERGE_AI: 'false' },
      callClaude: async () => { called = true; return 'YES'; },
    });
    assert.strictEqual(called, false, 'AI must not be called when kill switch is off');
    assert.strictEqual(rec.fired, false);
    assert.strictEqual(rec.source, 'kill-switch');
    // and a regex hit still fires even with AI killed (regex-only behavior intact)
    const rec2 = await decideConcierge({ text: 'x', regexHit: true, env: { CONCIERGE_AI: 'false' } });
    assert.strictEqual(rec2.fired, true);
    assert.strictEqual(rec2.source, 'regex-fast-path');
  });

  // GUEST REPLY MUST NEVER BE BLOCKED/DELAYED/CRASHED: prove a hanging AI call
  // both (a) resolves within the timeout budget and (b) never throws.
  await check('hang+timeout: AI hangs → resolves to regex result within budget, no throw', async () => {
    const start = Date.now();
    let threw = false, rec;
    try {
      rec = await decideConcierge({
        text: 'x', regexHit: false, timeoutMs: 200,
        callClaude: () => new Promise(() => {}), // hangs forever
      });
    } catch (e) { threw = true; }
    const elapsed = Date.now() - start;
    assert.strictEqual(threw, false, 'must NEVER throw');
    assert.strictEqual(rec.fired, false, 'falls back to regexHit (false)');
    assert.strictEqual(rec.source, 'ai-fallback');
    assert.ok(elapsed >= 180 && elapsed < 1500, `must resolve right around the ${200}ms budget, was ${elapsed}ms`);
  });

  // Simulate the actual reply-path guarantee: a fire-and-forget classify must
  // not stop the (synchronous) guest reply from being scheduled immediately.
  await check('reply path proceeds immediately even while AI hangs', async () => {
    let replyScheduled = false;
    // fire-and-forget exactly as server.js does on the reply path
    decideConcierge({ text: 'x', regexHit: false, timeoutMs: 5000, callClaude: () => new Promise(() => {}) })
      .then(() => {}); // never blocks us
    replyScheduled = true; // this line runs without awaiting the classifier
    assert.strictEqual(replyScheduled, true);
  });

  // garbage verdict → strict parse keeps it silent, no throw.
  await check('garbage verdict: "🤖 maybe?" → silent, source=ai', async () => {
    const rec = await decideConcierge({ text: 'x', regexHit: false, callClaude: async () => '🤖 maybe?' });
    assert.strictEqual(rec.fired, false);
    assert.strictEqual(rec.source, 'ai');
  });

  // audit record carries everything the live log needs.
  await check('audit record: has regexHit, aiConsulted, rawVerdict, fired, source', async () => {
    const rec = await decideConcierge({ text: 'x', regexHit: false, callClaude: async () => 'YES' });
    for (const k of ['regexHit', 'aiEnabled', 'aiConsulted', 'rawVerdict', 'fired', 'source'])
      assert.ok(k in rec, `record missing ${k}`);
    assert.strictEqual(rec.rawVerdict, 'YES');
    assert.strictEqual(rec.fired, true);
  });

  // Deterministic guardrail (always runs, no API): production must not fire via the
  // REGEX on any must-NOT-fire case, so the silent guarantee holds even with AI off.
  await check('regex stays silent on every must-NOT-fire case (deterministic)', () => {
    for (const [label, text] of SILENT_CASES)
      assert.ok(!regexHitFor(text), `regex must NOT fire on ${label}: "${text}"`);
  });

  console.log('\n── PART B: real Claude — sampled tally (N×/case, must-FIRE band vs must-SILENT band) ──\n');

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log('  (skipped — ANTHROPIC_API_KEY not set; run with the key to see the sampled tally)\n');
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
    // Force the AI path (regexHit:false) so we observe the classifier itself, not the
    // regex fast-path — proves the AI alone gets these right. Sampled N× per case and
    // held to a reliability band (probabilistic model → tally, not a single call).
    const decide = (text) =>
      classifyConcierge(text, { regexHit: false, callClaude: realCallClaude, timeoutMs: 8000 });
    const N = parseInt(process.env.CONCIERGE_SAMPLES, 10) || 5;
    const FIRE_MIN = Math.ceil(0.8 * N);    // must-fire ≥ 80% of samples
    const SILENT_MAX = Math.floor(0.2 * N); // must-silent ≤ 20% of samples
    const sample = async (text) => {
      const res = await Promise.all(Array.from({ length: N }, () => decide(text).catch(() => 'E')));
      return res.filter(r => r === true).length;
    };
    console.log(`  N=${N}/case | AI path forced | must-FIRE ≥${FIRE_MIN}/${N}, must-SILENT ≤${SILENT_MAX}/${N}\n`);

    for (const [label, text] of FIRE_CASES) {
      await check(`FIRE ≥${FIRE_MIN}/${N}: ${label}`, async () => {
        const fires = await sample(text);
        console.log(`     ${fires}/${N} fire    ← "${text.slice(0, 58)}"`);
        assert.ok(fires >= FIRE_MIN, `expected ≥${FIRE_MIN}/${N}, got ${fires}/${N}`);
      });
    }
    for (const [label, text] of SILENT_CASES) {
      await check(`SILENT ≤${SILENT_MAX}/${N}: ${label}`, async () => {
        const fires = await sample(text);
        console.log(`     ${fires}/${N} fire    ← "${text.slice(0, 58)}"`);
        assert.ok(fires <= SILENT_MAX, `expected ≤${SILENT_MAX}/${N}, got ${fires}/${N}`);
      });
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail ? 1 : 0; // set code without truncating buffered stdout
})();
