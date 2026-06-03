// Replay test for the conversation-history fix. Pulls the ACTUAL recent thread for
// three real reservations from Hospitable, finds the latest guest turn in each, and
// runs the NEW history-aware draftReply against it — printing the thread and the reply.
//
// These are the three threads that exposed the no-history bugs:
//   - Tony Barber,   18-A : "you are not answering my question" / "I cannot get into the apartment"
//   - Nyra Shelton,  4-L  : cash-vs-card payment + luggage
//   - Gabby Itohan,  7-B  : "do I use this code for the building AND the door"
//
// Requires HOSPITABLE_API_KEY + ANTHROPIC_API_KEY in the environment (pull from Railway).
// Run: HOSPITABLE_API_KEY=… ANTHROPIC_API_KEY=… node scripts/test-thread-reply.js

const {
  draftReply,
  fetchMessagesForReservation,
} = require('../src/server');

// Unit → Hospitable property UUID (CLAUDE.md) + the resolved reservation ID for the
// named guest (found via a wide date-range + paginated reservation sweep; the default
// reservation list only returns a narrow recent window so name lookup missed them).
const TARGETS = [
  { name: 'Tony Barber',  unit: '18-A', propertyId: '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc', reservationId: 'd11bcffd-cc63-4d03-a0a5-86d1bd855927' },
  { name: 'Nyra Shelton', unit: '4-L',  propertyId: 'bbe43523-c42a-46b0-8235-7ad08ae990c9', reservationId: 'e5ddbeed-6a0f-4f3c-85da-5131f22ae080' },
  { name: 'Gabby Itohan', unit: '7-B',  propertyId: '1af8fdde-58ee-426e-8374-6530397347e8', reservationId: '07cd7f37-7dbb-4609-aca9-542fe5ca72ed' },
];

const HOST_ROLES = new Set(['host', 'co-host', 'teammate']);
const isHost  = m => HOST_ROLES.has(m.sender_role || m.sender_type);

(async () => {
  if (!process.env.HOSPITABLE_API_KEY || !process.env.ANTHROPIC_API_KEY) {
    console.error('Need HOSPITABLE_API_KEY and ANTHROPIC_API_KEY in env (pull from Railway). Aborting.');
    process.exit(2);
  }

  for (const { name, unit, propertyId, reservationId } of TARGETS) {
    console.log('\n' + '='.repeat(78));
    console.log(`TARGET: ${name} — unit ${unit} — reservation ${reservationId}`);
    console.log('='.repeat(78));

    const guestName = name;
    let thread = [];
    try { thread = await fetchMessagesForReservation(reservationId); }
    catch (e) { console.log(`  ✗ thread fetch failed: ${e.message}`); continue; }

    const chrono = thread.slice().sort((a, b) =>
      (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0));

    console.log(`\n  --- thread (${chrono.length} msgs) ---`);
    for (const m of chrono) {
      const who = isHost(m) ? 'HOST ' : 'GUEST';
      const body = (m.body || '').replace(/\s+/g, ' ').trim();
      if (!body) continue;
      console.log(`   [${who}] ${body.slice(0, 140)}${body.length > 140 ? '…' : ''}`);
    }

    const lastGuest = [...chrono].reverse().find(m => !isHost(m) && (m.body || '').trim());
    if (!lastGuest) { console.log('  ✗ no guest message found in thread.'); continue; }
    const latestBody = lastGuest.body.trim();
    console.log(`\n  → latest guest turn: "${latestBody.slice(0, 120)}${latestBody.length > 120 ? '…' : ''}"`);

    const { reply, confident } = await draftReply(
      guestName, latestBody, `${unit} (Peachtree)`, propertyId, false, reservationId, 'reservation');

    console.log(`\n  ┌─ NEW AGENT REPLY  (confident=${confident}) ${confident ? '' : '→ would ESCALATE to host, no guest reply'}`);
    console.log('  │ ' + (reply ? reply.replace(/\n/g, '\n  │ ') : '(empty — escalate)'));
    console.log('  └' + '─'.repeat(70));
  }

  console.log('\nDONE.');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
