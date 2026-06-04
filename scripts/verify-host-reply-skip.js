// Real-world verification for the host-reply suppression change.
//
// Finds a REAL reservation where the guest sent a message and the host (me) replied
// after it, confirms the REAL hostRepliedAfterGuest() returns { replied: true }, then
// drives the REAL dispatchPendingReply() against that reservation and shows it logs
// "[skipped] host already replied" instead of sending.
//
// SAFE: AUTOSEND=false and a throwaway STATE_DIR are set before requiring the server,
// so nothing is ever sent to a guest and no real queue/state file is touched. The
// require.main guard means importing server.js does NOT boot the server/pollers.
//
// Run: node scripts/verify-host-reply-skip.js
const fs = require('fs');
const path = require('path');
const os = require('os');

// --- env: map .env HOSPITABLE_TOKEN → HOSPITABLE_API_KEY the server reads ---
const envPath = path.join(__dirname, '..', '.env');
const line = fs.readFileSync(envPath, 'utf8').split('\n').find(l => l.startsWith('HOSPITABLE_TOKEN='));
const token = line ? line.slice('HOSPITABLE_TOKEN='.length).trim() : '';
if (!token) { console.error('HOSPITABLE_TOKEN missing from .env'); process.exit(1); }
process.env.HOSPITABLE_API_KEY = token;
process.env.AUTOSEND = 'false';                                   // safety net #1: never send
process.env.STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-')); // safety net #2: temp state

const { fetchReservationsForProperty, hostRepliedAfterGuest, dispatchPendingReply, pendingReplies } = require('../src/server');

// The 7 managed Atlanta units (from CLAUDE.md).
const PROPERTY_IDS = [
  '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc', '80c21aac-00eb-49af-9094-6792839ff5a4',
  '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', '3e702102-a219-4c18-9f88-3a4d1ceb3825',
  'bbe43523-c42a-46b0-8235-7ad08ae990c9', '283977a3-3af3-4d90-8d95-b418a3014d90',
  '1af8fdde-58ee-426e-8374-6530397347e8',
];

(async () => {
  // 1. Find a real reservation whose thread shows host-replied-after-guest.
  let found = null;
  for (const pid of PROPERTY_IDS) {
    let reservations = [];
    try { reservations = await fetchReservationsForProperty(pid, 40); }
    catch (e) { console.warn(`  (skip property ${pid.slice(0,8)}: ${e.message})`); continue; }
    for (const r of reservations) {
      if (!r.id) continue;
      let res;
      try { res = await hostRepliedAfterGuest(r.id, 'reservation'); }
      catch { continue; }
      if (res.replied) { found = { reservation: r, res }; break; }
    }
    if (found) break;
  }

  if (!found) {
    console.error('\n✗ No reservation found where the host replied after the guest. ' +
      'Reply to one guest message in Hospitable, then re-run.');
    process.exit(2);
  }

  const { reservation, res } = found;
  const guestName = reservation.guest?.full_name || reservation.guest?.first_name || 'Guest';
  console.log('\n=== Step 1: real reservation with a host reply after the guest ===');
  console.log(`  reservation: ${reservation.id}`);
  console.log(`  guest:       ${guestName}`);
  console.log(`  guest last msg: ${new Date(res.lastGuest).toISOString()}`);
  console.log(`  host  last msg: ${new Date(res.lastHost).toISOString()}  (${res.lastHostAt})`);
  console.log(`  hostRepliedAfterGuest() → replied: ${res.replied}`);
  if (res.replied !== true) { console.error('✗ expected replied:true'); process.exit(3); }

  // 2. Queue a fake pending auto-reply for that REAL reservation and dispatch it.
  console.log('\n=== Step 2: drive the REAL dispatchPendingReply() (AUTOSEND=false) ===');
  const id = 'verify-' + Date.now();
  pendingReplies.set(id, {
    id, resourceId: reservation.id, resourceType: 'reservation',
    guestName, propertyName: 'VERIFY', propertyId: reservation.listing_id || null,
    originalMessage: 'verify', draftedReply: 'THIS SHOULD NOT BE SENT',
    editedReply: 'THIS SHOULD NOT BE SENT', status: 'pending', createdAt: Date.now(), sendAt: Date.now(),
  });

  // Tee console.log so we can assert on the exact log line the real code emits.
  const captured = [];
  const realLog = console.log;
  console.log = (...a) => { captured.push(a.join(' ')); realLog(...a); };
  await dispatchPendingReply(id);
  console.log = realLog;

  const skipLine = captured.find(l => l.includes('[skipped] host already replied'));
  const sendLine = captured.find(l => l.includes('[send] POST') || l.includes('AUTOSEND=false'));

  console.log(`\n  pending entry in queue after dispatch: ${pendingReplies.has(id) ? 'YES' : 'no (removed)'}`);
  console.log(`  skip log emitted:  ${skipLine ? 'YES' : 'NO'}`);
  console.log(`  any send attempt:  ${sendLine ? 'YES (BAD)' : 'no'}`);

  if (!skipLine) { console.error('\n✗ skip log not found — host-reply suppression did not fire'); process.exit(4); }
  if (sendLine)  { console.error('\n✗ a send was attempted — should have skipped'); process.exit(5); }
  if (pendingReplies.has(id)) { console.error('\n✗ entry not removed from queue'); process.exit(6); }

  console.log('\n✓ VERIFIED: host reply detected → auto-reply skipped, nothing sent.');
  console.log('  The exact log line:');
  console.log('    ' + skipLine.trim());
})().catch(e => { console.error('verify failed:', e); process.exit(1); });
