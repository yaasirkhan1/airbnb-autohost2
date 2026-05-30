// ─── Listing Vault ────────────────────────────────────────────────────────────
// Stores master listing content and generates Claude-powered variations

const vault = new Map(); // propertyId -> { master, variations[], updatedAt }

function getVault() {
  return Array.from(vault.entries()).map(([id, data]) => ({ id, ...data }));
}

function getVaultEntry(propertyId) {
  return vault.get(propertyId) || null;
}

function saveToVault(propertyId, master) {
  const existing = vault.get(propertyId) || { variations: [] };
  vault.set(propertyId, { ...existing, master, updatedAt: Date.now() });
}

function saveVariation(propertyId, variation) {
  const entry = vault.get(propertyId);
  if (!entry) return;
  entry.variations = entry.variations || [];
  entry.variations.unshift({ ...variation, createdAt: Date.now() });
  if (entry.variations.length > 20) entry.variations.pop();
}

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

module.exports = { getVault, getVaultEntry, saveToVault, saveVariation, generateVariation };
