// Persistence for the scheduled-reply queue (pendingReplies), so a reply sitting
// in its delay window survives a restart instead of being lost (deploy-churn fix).
// Writes to DATA_DIR (a Railway volume in prod). No side effects on require.
const fs = require('fs');
const path = require('path');

// STATE_DIR (a Railway volume in prod) so a queued reply survives a restart.
// Falls back to DATA_DIR, then the repo ./data, for back-compat.
const DEFAULT_FILE = path.join(
  process.env.STATE_DIR || process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'pending-replies.json'
);

// Persist the queue. Accepts a Map (pendingReplies) or an array of entries.
// Only 'pending' entries are kept, capped at 500, and the non-serializable
// `timer` (a Node Timeout) is stripped — leaving it in would make JSON.stringify
// throw and silently lose the whole file.
function savePending(entries, file = DEFAULT_FILE) {
  try {
    const arr = Array.isArray(entries) ? entries : [...entries.values()];
    const keep = arr
      .filter(e => e && e.status === 'pending')
      .slice(-500)
      .map(({ timer, ...rest }) => rest);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(keep));
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Load persisted pending entries. Missing/corrupt file → []. */
function loadPending(file = DEFAULT_FILE) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// On boot, classify restored entries:
//   overdue  — sendAt already passed → dispatch immediately
//   upcoming — sendAt in the future → re-arm a timer for the remaining delay
function partitionPending(entries, now = Date.now()) {
  const overdue = [], upcoming = [];
  for (const e of entries || []) {
    if (!e || e.status !== 'pending') continue;
    if ((e.sendAt || 0) <= now) overdue.push(e);
    else upcoming.push(e);
  }
  return { overdue, upcoming };
}

module.exports = { savePending, loadPending, partitionPending, DEFAULT_FILE };
