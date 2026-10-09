/**
 * Boost offers: the HybridAI platform asks, on a premium tool result, whether
 * the user wants to spend one of their boosts on it. Validated here at both
 * boundaries it crosses, the MCP result (container) and the approval progress
 * line (gateway), so only well-formed offers become a boost question.
 *
 * Only the user's answer spends a boost; nothing here is shown to the model.
 */

const BOOST_CATEGORIES = ['image', 'music', 'video'];
// The platform sends 32 hex chars (uuid4); the id must also survive being
// typed as one word in `/boost use <id>`.
const BOOST_OFFER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MODEL_NAME_CHARS = 120;

export function parseBoostPrompt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { category, modelName, available } = value;
  if (!BOOST_CATEGORIES.includes(category)) return null;
  const name = typeof modelName === 'string' ? modelName.trim() : '';
  if (!name || name.length > MAX_MODEL_NAME_CHARS) return null;
  if (!Number.isSafeInteger(available) || available < 0) return null;
  return { category, modelName: name, available };
}

export function parseBoostOffer(value) {
  const prompt = parseBoostPrompt(value);
  if (!prompt) return null;
  const id = typeof value.id === 'string' ? value.id : '';
  if (!BOOST_OFFER_ID_RE.test(id)) return null;
  return { id, ...prompt };
}
