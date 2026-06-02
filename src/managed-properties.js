// Scope allowlist — the bot manages ONLY these 7 Atlanta units at 300 Peachtree.
// Matched by STABLE Hospitable property ID, never by title: the listings get
// renamed (e.g. "World Cup…") and two of them (21-D, 23-N) currently share an
// identical title, so the ID is the only correct key.
//
// Keep in lockstep with CLAUDE.md Unit Mappings and the pricing engine's ID list.
const ATLANTA_PROPERTY_IDS = new Set([
  'bbe43523-c42a-46b0-8235-7ad08ae990c9', // 4-L
  '1af8fdde-58ee-426e-8374-6530397347e8', // 7-B
  '5a8cafc2-baa9-4fdb-b6dc-773bfcfb75bc', // 18-A
  '80c21aac-00eb-49af-9094-6792839ff5a4', // 21-D
  '7b7fda8b-e1d8-460f-8143-59a1a2b4d81c', // 21-I
  '283977a3-3af3-4d90-8d95-b418a3014d90', // 23-N
  '3e702102-a219-4c18-9f88-3a4d1ceb3825', // 24-L
]);

const isManaged = id => ATLANTA_PROPERTY_IDS.has(id);

// Keep only managed properties from a Hospitable /properties list (by id).
const filterManaged = properties => (properties || []).filter(p => p && ATLANTA_PROPERTY_IDS.has(p.id));

module.exports = { ATLANTA_PROPERTY_IDS, isManaged, filterManaged };
