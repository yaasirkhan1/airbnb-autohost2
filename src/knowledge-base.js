// Loader for the concierge / event-intelligence knowledge base (local-area facts:
// venues, distances, transit, events). Static reference content shipped in the repo,
// resolved via DATA_DIR (NOT the STATE_DIR volume). No side effects on require.
const fs = require('fs');
const path = require('path');

const KB_FILE = path.join(
  process.env.DATA_DIR || path.join(__dirname, '..', 'data'),
  'knowledge-base.md'
);

/** Read the knowledge base verbatim. Missing/unreadable → '' (feature degrades, no crash). */
function loadKnowledgeBase(file = KB_FILE) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

module.exports = { loadKnowledgeBase, KB_FILE };
