// Root-cause fix for deploy-churn (symptom 1/2): durable state across restarts.
//   (a) a persisted pending reply is RE-SENT after a simulated restart
//   (b) a persisted seen-key SUPPRESSES a re-reply after a simulated restart
// Both stores write to DATA_DIR (a Railway volume in prod). Pure + file-arg’d so
// we can round-trip through a temp file = a simulated restart.
// Run: node scripts/test-pending-store.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { savePending, loadPending, partitionPending } = require('../src/pending-store');
const { saveSeen, loadSeen } = require('../src/seen-store');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'churn-'));
const pendingFile = path.join(tmp, 'pending-replies.json');
const seenFile    = path.join(tmp, 'seen-messages.json');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

const NOW = Date.parse('2026-06-02T12:00:00Z');
const mkEntry = (id, sendAt, extra = {}) => ({
  id, resourceId: 'res-' + id, resourceType: 'reservation', guestName: 'Guest ' + id,
  editedReply: 'reply ' + id, draftedReply: 'reply ' + id, status: 'pending',
  createdAt: NOW - 60000, sendAt, ...extra,
});

// ── (a) pending replies survive a restart ───────────────────────────────────
check('savePending strips the non-serializable timer and persists pending only', () => {
  const live = new Map();
  live.set('a', mkEntry('a', NOW + 120000, { timer: setTimeout(() => {}, 1e6).unref() })); // future, has timer
  live.set('b', mkEntry('b', NOW - 1000));                                          // overdue
  live.set('c', mkEntry('c', NOW + 1000, { status: 'sent' }));                      // not pending → dropped
  const ok = savePending(live, pendingFile);
  assert.strictEqual(ok, true, 'savePending should succeed despite the timer object');
  const raw = fs.readFileSync(pendingFile, 'utf8');
  assert.ok(!raw.includes('"timer"'), 'timer must not be serialized');
  const loaded = loadPending(pendingFile);
  assert.deepStrictEqual(loaded.map(e => e.id).sort(), ['a', 'b'], 'only pending entries persist');
});

check('partitionPending: overdue (sendAt<=now) send-now, upcoming re-scheduled', () => {
  const loaded = loadPending(pendingFile);
  const { overdue, upcoming } = partitionPending(loaded, NOW);
  assert.deepStrictEqual(overdue.map(e => e.id), ['b']);
  assert.deepStrictEqual(upcoming.map(e => e.id), ['a']);
});

check('SIMULATED RESTART: overdue reply is re-sent, future reply is re-scheduled', () => {
  // restart = fresh load from disk (in-memory Map + timers are gone)
  const loaded = loadPending(pendingFile);
  const { overdue, upcoming } = partitionPending(loaded, NOW);

  const sent = [], scheduled = [];
  // this mirrors what restorePendingReplies() does on boot
  for (const e of overdue) sent.push(e.id);                       // dispatch immediately
  for (const e of upcoming) scheduled.push([e.id, e.sendAt - NOW]); // re-arm timer

  assert.deepStrictEqual(sent, ['b'], 'overdue reply "b" must be re-sent after restart');
  assert.deepStrictEqual(scheduled, [['a', 120000]], 'future reply "a" re-scheduled with remaining delay');
});

check('empty / missing pending file → [] (no crash)', () => {
  assert.deepStrictEqual(loadPending(path.join(tmp, 'nope.json')), []);
});

// ── (b) seen-key suppresses a re-reply after restart ────────────────────────
check('SIMULATED RESTART: a persisted seen-key suppresses a re-reply', () => {
  const key = 'res-42:platform-99';
  saveSeen(new Set([key]), seenFile);
  // restart = rebuild the in-memory set from disk
  const seen = loadSeen(seenFile);
  assert.ok(seen.has(key), 'persisted key must be restored');
  // mirrors the poller dedup gate: `if (seenMessageIds.has(key)) continue;`
  const wouldReply = k => !seen.has(k);
  assert.strictEqual(wouldReply(key), false, 'already-answered message must NOT be replied again');
  assert.strictEqual(wouldReply('res-42:new-message'), true, 'a new message still gets a reply');
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
