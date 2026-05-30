// ─── Listing Vault ────────────────────────────────────────────────────────────
// Stores master listing content and generates Claude-powered variations.
// Data is persisted to DATA_DIR/vault.json and reloaded on startup.

const fs   = require('fs');
const path = require('path');

const DATA_DIR  = process.env.DATA_DIR || path.join(__dirname, '../data');
const VAULT_PATH = path.join(DATA_DIR, 'vault.json');

const vault = new Map(); // propertyId -> { master, variations[], updatedAt }

// ─── Persistence ──────────────────────────────────────────────────────────────

function persistVault() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(VAULT_PATH, JSON.stringify(Object.fromEntries(vault), null, 2));
  } catch (e) {
    console.error('[vault] Failed to persist:', e.message);
  }
}

function loadVault() {
  if (!fs.existsSync(VAULT_PATH)) return;
  let raw;
  try {
    raw = fs.readFileSync(VAULT_PATH, 'utf8');
  } catch (e) {
    console.error('[vault] Could not read vault.json:', e.message);
    return;
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch (e) {
    // Corrupted JSON — back up and start clean so the server can still start
    const corrupt = VAULT_PATH + '.corrupt';
    try { fs.renameSync(VAULT_PATH, corrupt); } catch (_) {}
    console.error(`[vault] vault.json is corrupted (${e.message}) — backed up to vault.json.corrupt and starting with empty vault`);
    return;
  }
  try {
    for (const [id, data] of Object.entries(entries)) vault.set(id, data);
    console.log(`[vault] Loaded ${vault.size} entr${vault.size === 1 ? 'y' : 'ies'} from disk`);
  } catch (e) {
    console.error('[vault] Failed to populate vault from disk data:', e.message);
  }
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

function getVault() {
  return Array.from(vault.entries()).map(([id, data]) => ({ id, ...data }));
}

function getVaultEntry(propertyId) {
  return vault.get(propertyId) || null;
}

function saveToVault(propertyId, master) {
  const existing = vault.get(propertyId) || { variations: [] };
  vault.set(propertyId, { ...existing, master, updatedAt: Date.now() });
  persistVault();
}

function saveVariation(propertyId, variation) {
  const entry = vault.get(propertyId);
  if (!entry) return;
  entry.variations = entry.variations || [];
  entry.variations.unshift({ ...variation, createdAt: Date.now() });
  if (entry.variations.length > 20) entry.variations.pop();
  persistVault();
}

// ─── Claude: split a combined description into sections ───────────────────────

async function splitDescription(rawDescription, propertyName, callClaude) {
  if (!rawDescription?.trim()) return {};

  const prompt = `You are analyzing an Airbnb property listing description and splitting it into the standard Airbnb listing sections.

Analyze the text carefully and distribute the content into these sections:
- summary: The main 2-3 sentence hook introducing the property overall
- the_space: Description of the physical space — rooms, layout, furnishings, decor
- guest_access: What areas, amenities, or rooms guests can use
- neighborhood: The surrounding area, nearby attractions, local character
- getting_around: Transport options — parking, transit, walkability
- other_notes: Any remaining useful guest information that doesn't fit above

Rules:
- Never invent details not present in the original text
- If content for a section genuinely cannot be found, return "" for that key
- summary must always be populated if there is any content at all
- Preserve the original wording as closely as possible; just re-categorise

Return ONLY valid JSON with exactly these keys, no markdown fences, no explanation:
{
  "summary": "",
  "the_space": "",
  "guest_access": "",
  "neighborhood": "",
  "getting_around": "",
  "other_notes": ""
}`;

  const userMsg = `Property: "${propertyName}"\n\nCombined description to split into sections:\n\n${rawDescription}`;

  const raw = await callClaude(prompt, userMsg, 1500);
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    throw new Error('Claude returned invalid JSON while splitting description');
  }
}

// ─── Claude: generate a listing variation ────────────────────────────────────

async function generateVariation(propertyId, intensity, callClaude) {
  const entry = vault.get(propertyId);
  if (!entry?.master) throw new Error('No master content in vault for this property');

  const { title, summary, the_space, guest_access, neighborhood, getting_around, other_notes, houseRules, customNotes } = entry.master;

  const previousVariations = (entry.variations || []).slice(0, 5)
    .map(v => `Previous title used: "${v.title}"`)
    .join('\n');

  const INTENSITY_MAP = {
    light:  `Make light changes: reword sentences, vary the opening, shuffle paragraphs. Keep the same structure and selling points. Title should have a slightly different angle but same keywords.`,
    medium: `Make moderate changes: rewrite sections with a different narrative flow, lead with different strengths, use different vocabulary. Title should be meaningfully different — different adjectives, different emphasis.`,
    heavy:  `Completely reimagine the listing. Write from a totally different angle — if the original led with location, lead with the space. Facts stay the same but everything else should be unrecognizable. Title must be completely different.`,
  };
  const intensityInstructions = INTENSITY_MAP[intensity] || INTENSITY_MAP.medium;

  const prompt = `You are an expert Airbnb copywriter. Create a variation of this listing that:
1. Describes the EXACT same property with the EXACT same facts
2. Is written differently enough that Airbnb's duplicate detection won't flag it
3. Is high quality and appealing to guests

${intensityInstructions}

${previousVariations ? `IMPORTANT — avoid these previously used titles:\n${previousVariations}\n` : ''}

Return ONLY valid JSON with these exact keys, no markdown, no explanation:
{
  "title": "50 char max listing title",
  "summary": "2-3 sentence hook / main description",
  "the_space": "3-4 sentences describing the physical space",
  "guest_access": "what areas/amenities guests can access",
  "neighborhood": "2-3 sentences about the neighborhood",
  "getting_around": "1-2 sentences on local transport options",
  "other_notes": "any other useful notes for guests",
  "houseRules": "house rules as a concise paragraph"
}`;

  const userMsg = `Original listing content:

TITLE: ${title}
SUMMARY: ${summary || '(empty)'}
THE SPACE: ${the_space || '(empty)'}
GUEST ACCESS: ${guest_access || '(empty)'}
NEIGHBORHOOD: ${neighborhood || '(empty)'}
GETTING AROUND: ${getting_around || '(empty)'}
OTHER NOTES: ${other_notes || '(empty)'}
HOUSE RULES: ${houseRules || '(empty)'}
${customNotes ? `\nCUSTOM NOTES (always keep these facts): ${customNotes}` : ''}

Generate a ${intensity} variation:`;

  const raw = await callClaude(prompt, userMsg, 2000);

  let parsed;
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error('Claude returned invalid JSON — try again');
  }

  const variation = {
    title:          parsed.title,
    summary:        parsed.summary,
    the_space:      parsed.the_space,
    guest_access:   parsed.guest_access,
    neighborhood:   parsed.neighborhood,
    getting_around: parsed.getting_around,
    other_notes:    parsed.other_notes,
    houseRules:     parsed.houseRules,
    intensity,
    propertyId,
  };

  saveVariation(propertyId, variation);
  return variation;
}

// Load persisted data on startup — wrapped so any unexpected error never
// prevents the module from loading and crashing the server
try {
  loadVault();
} catch (e) {
  console.error('[vault] Unexpected error during loadVault — starting with empty vault:', e.message);
}

module.exports = { getVault, getVaultEntry, saveToVault, saveVariation, splitDescription, generateVariation };
