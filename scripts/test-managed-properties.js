// Scope guard — the bot must act ONLY on the 7 Atlanta units, matched by STABLE
// property ID (not by title), so the "World Cup…" renames don't matter and the
// 43 San Juan/Unnamed listings on the account are dropped.
// Run: node scripts/test-managed-properties.js
const assert = require('assert');
const { ATLANTA_PROPERTY_IDS, isManaged, filterManaged } = require('../src/managed-properties');

let pass = 0, fail = 0;
const check = (n, f) => { try { f(); console.log('✓', n); pass++; } catch (e) { console.log('✗', n, '\n   ', e.message); fail++; } };

const ID = {
  '4-L':  'bbe43523-c42a-46b0-8235-7ad08ae990c9',
  '7-B':  '1af8fdde-58ee-426e-8374-6530397347e8',
  '18-A': '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc',
  '21-D': '80c21aac-00eb-49af-9094-6792839ff5a4',
  '21-I': '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c',
  '23-N': '283977a3-3af3-4d90-8d95-b418a3014d90',
  '24-L': '3e702102-a219-4c18-9f88-3a4d1ceb3825',
};

// Live property list shape: renamed "World Cup…" titles, 21-D & 23-N share an
// IDENTICAL title, plus San Juan + Unnamed listings that must be dropped.
const liveProps = [
  { id: ID['4-L'],  public_name: 'World Cup Lodging Flat 10 to 14-Night Rate Short Walk to Arena' },
  { id: ID['7-B'],  public_name: 'World Cup Apartment Flat 10 to 14 Nights Premier Arena Location' },
  { id: ID['18-A'], public_name: 'Downtown 1BR High-Rise • City Views • Walk to Park' },
  { id: ID['21-D'], public_name: 'World Cup Traveler Package Flat Rate Arena Footsteps Away' }, // identical title…
  { id: ID['21-I'], public_name: 'Spacious 2BR 1150sqft | 21st Floor City Views' },
  { id: ID['23-N'], public_name: 'World Cup Traveler Package Flat Rate Arena Footsteps Away' }, // …to 23-N
  { id: ID['24-L'], public_name: 'World Cup Flat Rate Stay 10 to 14 Nights Walk to Arena' },
  { id: 'a6d65741-58e6-4747-9a6a-a2440a5befb7', public_name: 'Spanish Soul in the Heart of Old San Juan' },
  { id: '98029fb9-5c94-42af-bed9-914774ba7300', public_name: 'Historic Oasis located in Heart of Old San Juan' },
  { id: '7ea732cc-7768-432f-adc7-1904a1b2fe90', public_name: 'Unnamed Property' },
  { id: '2a30f73f-1c1f-4df0-b074-fd2054a79e5e', public_name: 'Unnamed Property' },
];

check('allowlist is exactly the 7 expected IDs', () => {
  assert.strictEqual(ATLANTA_PROPERTY_IDS.size, 7);
  for (const id of Object.values(ID)) assert.ok(ATLANTA_PROPERTY_IDS.has(id), `missing ${id}`);
});

check('filter keeps exactly the 7 managed IDs despite "World Cup" renames', () => {
  const kept = filterManaged(liveProps).map(p => p.id).sort();
  assert.deepStrictEqual(kept, Object.values(ID).sort());
});

check('San Juan + Unnamed listings are dropped', () => {
  const keptIds = new Set(filterManaged(liveProps).map(p => p.id));
  for (const dropped of ['a6d65741-58e6-4747-9a6a-a2440a5befb7','98029fb9-5c94-42af-bed9-914774ba7300','7ea732cc-7768-432f-adc7-1904a1b2fe90'])
    assert.ok(!keptIds.has(dropped), `should have dropped ${dropped}`);
});

check('21-D and 23-N (identical titles) are BOTH kept as distinct IDs', () => {
  const keptIds = filterManaged(liveProps).map(p => p.id);
  assert.ok(keptIds.includes(ID['21-D']), '21-D missing');
  assert.ok(keptIds.includes(ID['23-N']), '23-N missing');
  assert.notStrictEqual(ID['21-D'], ID['23-N']); // distinct IDs, same title
});

check('isManaged: true for a managed ID, false for San Juan', () => {
  assert.strictEqual(isManaged(ID['24-L']), true);
  assert.strictEqual(isManaged('a6d65741-58e6-4747-9a6a-a2440a5befb7'), false);
  assert.strictEqual(isManaged(null), false);
});

console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
process.exitCode = fail ? 1 : 0;
