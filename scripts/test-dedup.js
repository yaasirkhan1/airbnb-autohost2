// Proves a single guest message arriving via BOTH the poller and the webhook
// is handled exactly ONCE (one reply attempt, not two). Guards the dedup-key
// unification fix. Run: node scripts/test-dedup.js
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

// Pull the real messageKey() out of source (no server boot) so the test uses
// the exact production key formula.
const mk = src.match(/function messageKey\([\s\S]*?\n}/);
assert.ok(mk, 'could not locate messageKey() in server.js');
eval(mk[0]); // defines messageKey in this scope

let pass = 0;
function check(name, fn) { fn(); console.log('✓', name); pass++; }

// Regression guard: the webhook dedup MUST use messageKey() — the same formula as
// the poller — otherwise the two paths compute different keys and never dedup.
check('webhook dedup uses messageKey() (same formula as poller)', () => {
  assert.ok(/const dedupKey = messageKey\(/.test(src),
    'webhook handler must compute dedupKey via messageKey(replyResourceId, msg)');
  assert.ok(!/const dedupKey = `\$\{replyResourceType\}/.test(src),
    'old prefixed webhook dedup key must be gone');
});

// The actual behavior: one message, both ingestion paths, shared seenMessageIds.
check('one guest message via poller + webhook → exactly ONE reply attempt', () => {
  const seen = new Set();          // mirrors the shared seenMessageIds Set
  let replyAttempts = 0;
  const ingest = (resourceId, msg) => {      // both paths do exactly this
    const key = messageKey(resourceId, msg);
    if (seen.has(key)) return;               // dedup guard
    seen.add(key);
    replyAttempts++;                         // == one scheduleReply()/send
  };
  const msg = {
    platform_id: 'AIRBNB-MSG-123',
    reservation_id: 'f1d8934a-78bf-47f5-b108-3babf9596932',
    body: 'Hey Cal, do you have an entry code for me?',
    created_at: '2026-06-01T22:10:00Z',
  };
  ingest(msg.reservation_id, msg);   // poller:  messageKey(resourceId, msg)
  ingest(msg.reservation_id, msg);   // webhook: messageKey(replyResourceId, msg)
  assert.strictEqual(replyAttempts, 1, `expected 1 reply attempt, got ${replyAttempts}`);
});

// Negative control: the OLD mismatched keys would have produced TWO (the bug).
check('regression control: old mismatched keys produced 2 (the bug)', () => {
  const seen = new Set(); let n = 0;
  const msg = { platform_id: 'AIRBNB-MSG-123', created_at: 'x' };
  const poller = (resId) => { const k = messageKey(resId, msg); if (!seen.has(k)) { seen.add(k); n++; } };
  const webhookOld = (type, resId) => { const k = `${type}:${resId}:${msg.platform_id || msg.created_at}`; if (!seen.has(k)) { seen.add(k); n++; } };
  poller('f1d8934a');
  webhookOld('reservation', 'f1d8934a');
  assert.strictEqual(n, 2, 'old keys should mismatch and double-send');
});

console.log(`\nRESULT: ${pass}/3 passed`);
