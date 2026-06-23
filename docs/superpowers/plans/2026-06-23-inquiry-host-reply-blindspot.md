# Inquiry Host-Reply Blind Spot — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the auto-responder from contradicting what the host told a guest, by ingesting the host's own messages into the inquiry buffer and giving the model a host-in-thread-authority directive.

**Architecture:** Two surgical changes to `src/server.js`. (1) The webhook handler currently drops host-role messages before buffering; instead, buffer them then return (still never reply to them). (2) Add a static guardrail directive to the cached system prompt that makes the host's in-thread statements override stored house rules/amenities/policies, bounded so money/refunds and safety still hold. A small dependency-injection seam on `draftReply` lets tests capture the assembled prompt without a live model call.

**Tech Stack:** Node.js (CommonJS), Express, Anthropic SDK. Tests are plain `node scripts/test-*.js` files using `assert` (no test runner; no `npm test`).

## Global Constraints

- Single entrypoint `src/server.js` (~3,748 lines); all logic lives here. Follow existing patterns.
- Tests are standalone scripts: `node scripts/test-<name>.js`, `'use strict'`, `const assert = require('assert')`, require from `../src/server`, print `✓`/`✗`, `process.exit(1)` on failure.
- Host sender roles are `host`, `co-host`, `teammate` (existing `HOST_REPLY_ROLES` Set, `src/server.js:147`).
- Buffer shape (from `pushConvoMsg`, `src/server.js:117-124`): `{ body, sender_role, created_at }`.
- Host authority is bounded: it overrides house rules / amenities / policies ONLY — it does NOT override the money/refund escalation (`isMoneyComplaint`, `src/server.js:1967`) or safety.
- Work on branch `fix/inquiry-host-reply-blindspot`. Show diff + real test output. Do NOT deploy until the host explicitly says so.

---

### Task 1: Ingest host-role webhooks into the conversation buffer

**Files:**
- Modify: `src/server.js:1873-1877` (webhook host short-circuit)
- Modify: `src/server.js:3735-3748` (module.exports — add `pushConvoMsg`, `recentMsgsByConvo`)
- Test: `scripts/test-host-reply-buffer.js` (create)

**Interfaces:**
- Consumes: `pushConvoMsg(conversationId, role, body)` (`src/server.js:117`), `buildThreadMessages(thread, latestBody, cap)` (`src/server.js:1456`), `recentMsgsByConvo` Map (`src/server.js:113`).
- Produces: exported `pushConvoMsg` and `recentMsgsByConvo` so tests can seed/inspect the buffer.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-host-reply-buffer.js`:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-host-reply-buffer.js`
Expected: FAIL — `pushConvoMsg`/`recentMsgsByConvo` are `undefined` (not yet exported): `TypeError: ... is not a function`.

- [ ] **Step 3: Export `pushConvoMsg` and `recentMsgsByConvo`**

In `src/server.js`, edit the `module.exports` object (starts line 3735). Add to the first line of exports:

```js
module.exports = {
  detectHardcodedResponse, draftReply, isParkingQuestion, CONCIERGE_REGEX, isMoneyComplaint,
  pushConvoMsg, recentMsgsByConvo,
```

- [ ] **Step 4: Buffer host-role webhooks instead of dropping them**

In `src/server.js`, replace the host short-circuit at lines 1873-1877:

```js
  const senderRole = msg.sender_role;
  if (senderRole === 'host' || senderRole === 'co-host' || senderRole === 'teammate') {
    console.log(`[webhook] sender_role="${senderRole}" — ignoring`);
    return;
  }
```

with:

```js
  const senderRole = msg.sender_role;
  if (HOST_REPLY_ROLES.has(senderRole)) {
    // Host/co-host/teammate reply (incl. ones the host typed in the Airbnb app and Hospitable
    // mirrored to us). DO NOT generate a reply to it — but DO buffer it so the bot stays
    // consistent with what the host told the guest. For inquiries this is the ONLY thread
    // history that exists (GET /inquiries/{id}/messages is 405). pushConvoMsg no-ops on a
    // missing conversation_id or empty body.
    if (msg.conversation_id) pushConvoMsg(msg.conversation_id, 'host', (msg.body || '').trim());
    console.log(`[webhook] sender_role="${senderRole}" — buffered host reply, not replying`);
    return;
  }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node scripts/test-host-reply-buffer.js`
Expected: PASS — `3 passed`.

- [ ] **Step 6: Commit**

```bash
git add src/server.js scripts/test-host-reply-buffer.js
git commit -m "Ingest host-role webhooks into inquiry buffer (was dropped at 1873)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Add the host-in-thread-authority directive to the system prompt

**Files:**
- Modify: `src/server.js` (add `HOST_AUTHORITY_DIRECTIVE` const near the other prompt guardrails, e.g. just above `draftReply` at line 1540; wire it into both `stableSystem` branches at 1677 and 1690)
- Modify: `src/server.js:3735` (module.exports — add `HOST_AUTHORITY_DIRECTIVE`)
- Test: `scripts/test-host-authority-directive.js` (create)

**Interfaces:**
- Produces: exported `const HOST_AUTHORITY_DIRECTIVE` (string) — consumed by Task 3's assembled-prompt assertion.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-host-authority-directive.js`:

```js
// The host-in-thread-authority directive must (a) make host statements override stored
// rules/amenities/policies and (b) be bounded — never override money/refunds or safety.
// Run: node scripts/test-host-authority-directive.js
'use strict';
const assert = require('assert');
const { HOST_AUTHORITY_DIRECTIVE } = require('../src/server');

let pass = 0;
const ok = (n, f) => { f(); console.log('✓', n); pass++; };

ok('directive exists and is a non-empty string', () => {
  assert.strictEqual(typeof HOST_AUTHORITY_DIRECTIVE, 'string');
  assert.ok(HOST_AUTHORITY_DIRECTIVE.length > 50, 'directive has real content');
});

ok('directive asserts host statements OVERRIDE stored rules and must not be contradicted', () => {
  const t = HOST_AUTHORITY_DIRECTIVE.toLowerCase();
  assert.ok(t.includes('override'), 'mentions override');
  assert.ok(t.includes('house rules') || t.includes('rules'), 'scopes to rules/policies');
  assert.ok(t.includes('contradict'), 'forbids contradicting the host');
});

ok('directive carves out money/refunds and safety', () => {
  const t = HOST_AUTHORITY_DIRECTIVE.toLowerCase();
  assert.ok(t.includes('refund') || t.includes('money'), 'money/refund carve-out present');
  assert.ok(t.includes('safe'), 'safety carve-out present');
});

console.log(`\n${pass} passed`);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-host-authority-directive.js`
Expected: FAIL — `HOST_AUTHORITY_DIRECTIVE` is `undefined`: `assert ... typeof === 'string'` fails.

- [ ] **Step 3: Define the directive constant**

In `src/server.js`, add immediately above `async function draftReply(` (line 1540):

```js
// HOST IN-THREAD AUTHORITY — a statement the host already made to THIS guest in the thread
// outranks the stored house rules / amenities / policies. The bot must stay consistent with it
// and NEVER contradict it. Bounded: does NOT extend to money/refunds (still escalated) or safety.
const HOST_AUTHORITY_DIRECTIVE = `HOST DIRECTION OVERRIDES STORED RULES: If the host has already told this guest something earlier in this conversation, that statement is authoritative and OVERRIDES the stored house rules, amenities, and policies above. Stay consistent with what the host told the guest and NEVER contradict it — for example, if the host said smoking is allowed on the patio, do not tell the guest smoking is prohibited. This authority is limited to house rules, amenities, and policies: it does NOT permit promising refunds or money back (money and refund matters are still escalated to a human), and it never overrides safety.`;
```

- [ ] **Step 4: Wire the directive into both stableSystem branches**

In `src/server.js`, in the `profileData?.profile` branch, change line 1676-1677 from:

```js
${factsSection}
${JSON_INSTRUCTIONS}`;
```

to:

```js
${factsSection}
${HOST_AUTHORITY_DIRECTIVE}
${JSON_INSTRUCTIONS}`;
```

Then make the identical change in the `else` branch (lines 1689-1690).

- [ ] **Step 5: Export the constant**

Add `HOST_AUTHORITY_DIRECTIVE` to `module.exports` (line 3735 block):

```js
  pushConvoMsg, recentMsgsByConvo, HOST_AUTHORITY_DIRECTIVE,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `node scripts/test-host-authority-directive.js`
Expected: PASS — `3 passed`.

- [ ] **Step 7: Commit**

```bash
git add src/server.js scripts/test-host-authority-directive.js
git commit -m "Add host-in-thread-authority directive to guest-reply prompt

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: Capture the assembled prompt (the Rebecka before/after) via an injected callClaude

**Files:**
- Modify: `src/server.js:1540` (add trailing `deps = {}` param to `draftReply`), `src/server.js:1760` (use injected callClaude)
- Test: `scripts/test-rebecka-prompt.js` (create)

**Interfaces:**
- Consumes: `draftReply(guestName, messageBody, propertyName, propertyId, conciergeHit, resourceId, resourceType, conversationId, deps)`; `pushConvoMsg`, `recentMsgsByConvo` (Task 1); `HOST_AUTHORITY_DIRECTIVE` (Task 2).
- Produces: `deps.callClaude` injection point — a test passes `{ callClaude: fake }` to capture `systemBlocks` + `promptInput` with no network call.

- [ ] **Step 1: Write the failing test**

Create `scripts/test-rebecka-prompt.js`:

```js
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
  if (pass < 5) process.exit(1);
})().catch(e => { console.error('✗', e.message); process.exit(1); });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node scripts/test-rebecka-prompt.js`
Expected: FAIL — `draftReply` ignores the 9th arg and calls the real `callClaude` (network/`ANTHROPIC_API_KEY` error, or `captured` stays null). Confirms the injection seam doesn't exist yet.

- [ ] **Step 3: Add the injection seam to draftReply**

In `src/server.js`, change the signature (line 1540) from:

```js
async function draftReply(guestName, messageBody, propertyName, propertyId, conciergeHit = false, resourceId = null, resourceType = null, conversationId = null) {
```

to:

```js
async function draftReply(guestName, messageBody, propertyName, propertyId, conciergeHit = false, resourceId = null, resourceType = null, conversationId = null, deps = {}) {
```

Then change the model call (line 1760) from:

```js
  const raw = await callClaude(systemBlocks, promptInput, 600, 'claude-sonnet-4-6');
```

to:

```js
  const _callClaude = deps.callClaude || callClaude;
  const raw = await _callClaude(systemBlocks, promptInput, 600, 'claude-sonnet-4-6');
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node scripts/test-rebecka-prompt.js`
Expected: PASS — `5 passed`.

- [ ] **Step 5: Commit**

```bash
git add src/server.js scripts/test-rebecka-prompt.js
git commit -m "Test: Rebecka prompt now carries host reply + authority directive

Adds an injected-callClaude seam to draftReply so the assembled prompt is
capturable without a live model call.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 4: Live demonstration — model honors the host (manual, gated on API key)

**Files:**
- Create: `scripts/demo-rebecka-honors-host.js`

**Interfaces:**
- Consumes: `draftReply`, `pushConvoMsg`, `recentMsgsByConvo` with the REAL `callClaude` (no injection) — requires `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Write the demo script**

Create `scripts/demo-rebecka-honors-host.js`:

```js
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
```

- [ ] **Step 2: Run the demo (manual)**

Run: `node scripts/demo-rebecka-honors-host.js`
Expected: the AFTER reply permits patio smoking; it does NOT recite "no smoking anywhere". Capture both outputs to show the host. (If `ANTHROPIC_API_KEY` is unset locally, run after providing it; this step is a demonstration, not a gating test.)

- [ ] **Step 3: Commit**

```bash
git add scripts/demo-rebecka-honors-host.js
git commit -m "Demo: model honors host patio-smoking reply over stored no-smoking rule

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 5: Verify host Airbnb-app replies arrive as webhooks (production logs)

**Files:** none (operational verification documented in the spec).

- [ ] **Step 1: Pull production logs and confirm a host webhook arrives**

The fix's Part 1 only helps if a reply the host types in the Airbnb app actually reaches us as a `message.created` webhook with `sender_role:'host'`. Confirm from Railway logs (airbnb-autohost2 project):

Run (link to the airbnb-autohost2 service first if needed):
```bash
railway logs -n 500 | grep -iE "sender_role=\"host\"|buffered host reply|sender_role.*co-host|sender_role.*teammate"
```
Expected: at least one line showing a host/co-host/teammate `message.created` was received (post-deploy this reads `buffered host reply, not replying`). If NONE ever appear even when the host has replied in the Airbnb app, then Hospitable does not mirror Airbnb-app host messages to us — record that finding; Part 2 (the authority directive) remains the safety net, and Part 1 still covers host replies sent via Hospitable/Telegram.

- [ ] **Step 2: Record the finding**

Note the result (host webhooks DO / DO NOT arrive for Airbnb-app replies) in the PR description / back to the host. No code change.

---

### Task 6: Full regression pass

- [ ] **Step 1: Run the touched-area test scripts**

Run:
```bash
node scripts/test-host-reply-buffer.js && \
node scripts/test-host-authority-directive.js && \
node scripts/test-rebecka-prompt.js && \
node scripts/test-thread-leading-host.js && \
node scripts/test-thread-reply.js && \
node scripts/test-full-thread-deescalation.js && \
node scripts/test-money-complaint.js && \
node scripts/test-draft-parse.js
```
Expected: every script prints its `✓` lines and exits 0 (no `✗`, no non-zero exit). The last four guard against regressions in thread assembly, the money/refund boundary, and draft parsing.

- [ ] **Step 2: Show the host the full diff + test output and WAIT**

```bash
git --no-pager diff main...HEAD -- src/server.js
```
Present the diff and the Step 1 output. Do NOT deploy (`railway up` / push to `main`) until the host explicitly says to.
