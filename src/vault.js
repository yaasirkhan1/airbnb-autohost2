// ─── Listing Vault ────────────────────────────────────────────────────────────
// Stores master listing content and generates Claude-powered variations

const vault = new Map(); // propertyId -> { master, variations[], createdAt }

function getVault() {
  return Array.from(vault.entries()).map(([id, data]) => ({ id, ...data }));
}

function getVaultEntry(propertyId) {
  return vault.get(propertyId) || null;
}

function saveToVault(propertyId, master) {
  const existing = vault.get(propertyId) || { variations: [] };
  vault.set(propertyId, {
    ...existing,
    master,
    updatedAt: Date.now(),
  });
}

function saveVariation(propertyId, variation) {
  const entry = vault.get(propertyId);
  if (!entry) return;
  entry.variations = entry.variations || [];
  entry.variations.unshift({ ...variation, createdAt: Date.now() });
  if (entry.variations.length > 20) entry.variations.pop(); // keep last 20
}

async function generateVariation(propertyId, intensity, callClaude) {
  const entry = vault.get(propertyId);
  if (!entry?.master) throw new Error('No master content in vault for this property');

  const { title, description, houseRules, customNotes } = entry.master;

  const previousVariations = (entry.variations || []).slice(0, 5).map(v =>
    `Previous title used: "${v.title}"`
  ).join('\n');

  const INTENSITY_MAP = {
    light: `Make light changes: reword sentences, vary the opening, shuffle some description paragraphs. Keep the same overall structure and selling points. Title should have a slightly different angle but same keywords.`,
    medium: `Make moderate changes: rewrite the description with a different narrative flow, lead with different strengths of the property, use different vocabulary throughout. Title should be meaningfully different — different adjectives, different emphasis.`,
    heavy: `Completely reimagine the listing copy. Write the description from a totally different angle — if the original led with location, lead with the space. If it was cozy/warm in tone, make it sleek/modern. The content facts stay the same but everything else should be unrecognizable compared to the original. Title must be completely different.`,
  };
  const intensityInstructions = INTENSITY_MAP[intensity] || INTENSITY_MAP.medium;

  const prompt = `You are an expert Airbnb copywriter. Your job is to create a variation of a listing that:
1. Describes the EXACT same property with the EXACT same facts
2. Is written differently enough that Airbnb's duplicate detection won't flag it
3. Is high quality and appealing to guests

${intensityInstructions}

${previousVariations ? `IMPORTANT — avoid these previously used titles:\n${previousVariations}\n` : ''}

Return ONLY a JSON object with these exact keys, no markdown, no explanation:
{
  "title": "...",
  "description": "...",
  "houseRules": "..."
}`;

  const userMsg = `Original listing content:

TITLE: ${title}

DESCRIPTION: ${description}

HOUSE RULES: ${houseRules}

${customNotes ? `CUSTOM NOTES (keep these facts): ${customNotes}` : ''}

Generate a ${intensity} variation:`;

  const raw = await callClaude(prompt, userMsg, 1500);

  let parsed;
  try {
    const clean = raw.replace(/```json|```/g, '').trim();
    parsed = JSON.parse(clean);
  } catch (e) {
    throw new Error('Claude returned invalid JSON — try again');
  }

  const variation = {
    title: parsed.title,
    description: parsed.description,
    houseRules: parsed.houseRules,
    intensity,
    propertyId,
  };

  saveVariation(propertyId, variation);
  return variation;
}

module.exports = { getVault, getVaultEntry, saveToVault, saveVariation, generateVariation };
