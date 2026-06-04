// Per-conversation host-alert throttle: state machine + persistence.
// No side effects on require — decideAlert is pure and unit-testable.
//
// Goal: stop one host-alert SMS per inbound guest message. Per conversation we
// send ONE alert, suppress for 15 min, then send up to 2 collapsed reminders if
// the guest keeps messaging AND the host hasn't replied, then go silent. A 6h+
// quiet gap resets the cycle. A detected host reply marks the convo resolved.
const fs = require('fs');
const path = require('path');

// STATE_DIR (a Railway volume in prod) so alert state survives restarts, exactly
// like seen-store / pending-store. Falls back to DATA_DIR, then the repo ./data.
const DEFAULT_FILE = path.join(
  process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'alert-state.json'
);

const SUPPRESS_WINDOW_MS = 15 * 60 * 1000;       // no alerts for 15 min after one fires
const RESET_GAP_MS       = 6 * 60 * 60 * 1000;   // 6h of quiet → fresh cycle
const MAX_REMINDERS      = 2;                     // reminders allowed after the first alert

// A fresh cycle for a conversation whose first message just arrived.
function freshCycle(now) {
  return {
    firstAlertAt: now, lastAlertAt: now,
    reminderCount: 0, pendingCount: 0,
    lastGuestMsgAt: now, lastHostReplyAt: null, resolved: false,
  };
}

/**
 * Decide what to do when a guest message arrives that would otherwise alert the host.
 * Pure: takes the prior state (or undefined), the current time, and whether a host
 * reply is already present in the thread after the guest's latest message.
 *
 * Returns { action, state, count? } where action is one of:
 *   'first'    — send the first alert for this conversation
 *   'reminder' — send a collapsed reminder ("N new messages, still needs reply")
 *   'suppress' — inside the 15-min window: count it, send nothing
 *   'silent'   — max reminders hit (or already resolved this cycle): send nothing
 *   'resolved' — host already replied: mark resolved, send nothing
 */
function decideAlert(state, now, hostReplied = false) {
  // Reset: no state yet, or the conversation went quiet for 6h+ and is starting over.
  const quietGap = state ? now - (state.lastGuestMsgAt || 0) : Infinity;
  if (!state || quietGap >= RESET_GAP_MS) {
    if (hostReplied) {
      const s = freshCycle(now);
      s.resolved = true; s.lastHostReplyAt = now;
      return { action: 'resolved', state: s };
    }
    return { action: 'first', state: freshCycle(now) };
  }

  // Active cycle. Always record this new guest message time (drives the 6h reset).
  // Host already replied after the guest's latest message → conversation is resolved.
  if (hostReplied) {
    return {
      action: 'resolved',
      state: { ...state, resolved: true, lastHostReplyAt: now, lastGuestMsgAt: now, pendingCount: 0 },
    };
  }

  // Resolved earlier this cycle (host replied) but guest is messaging again within 6h:
  // stay silent until a genuine 6h gap resets things.
  if (state.resolved) {
    return { action: 'silent', state: { ...state, lastGuestMsgAt: now } };
  }

  // Inside the suppression window → accumulate, send nothing.
  if (now - state.lastAlertAt < SUPPRESS_WINDOW_MS) {
    return { action: 'suppress', state: { ...state, pendingCount: state.pendingCount + 1, lastGuestMsgAt: now } };
  }

  // Window passed. Out of reminders → go silent.
  if (state.reminderCount >= MAX_REMINDERS) {
    return { action: 'silent', state: { ...state, lastGuestMsgAt: now } };
  }

  // Window passed, reminders remain → send ONE collapsed reminder. Count includes
  // the messages suppressed during the window plus this triggering message.
  const count = state.pendingCount + 1;
  return {
    action: 'reminder', count,
    state: {
      ...state, lastAlertAt: now, reminderCount: state.reminderCount + 1,
      pendingCount: 0, lastGuestMsgAt: now,
    },
  };
}

/** Load persisted alert state into a Map<conversationKey, state>. Missing/corrupt → empty. */
function loadAlerts(file = DEFAULT_FILE) {
  try {
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map(Object.entries(obj && typeof obj === 'object' ? obj : {}));
  } catch {
    return new Map();
  }
}

/** Persist the Map atomically. Bounded to the 2000 most recently active conversations. */
function saveAlerts(map, file = DEFAULT_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entries = [...map.entries()]
      .sort((a, b) => (b[1]?.lastGuestMsgAt || 0) - (a[1]?.lastGuestMsgAt || 0))
      .slice(0, 2000);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  decideAlert, loadAlerts, saveAlerts,
  DEFAULT_FILE, SUPPRESS_WINDOW_MS, RESET_GAP_MS, MAX_REMINDERS,
};
