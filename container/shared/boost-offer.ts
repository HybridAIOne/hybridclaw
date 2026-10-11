/**
 * Boost offers: the HybridAI platform asks, on a premium tool result, whether
 * the user wants to spend one of their boosts on it. Validated here at both
 * boundaries it crosses, the MCP result (container) and the approval progress
 * line (gateway), so only well-formed offers become a boost question.
 *
 * Only the user's answer spends a boost; nothing here is shown to the model.
 */

export type BoostCategory = 'image' | 'music' | 'video';

/** What the app's boost popup shows; part of a pending approval. */
export interface BoostPrompt {
  category: BoostCategory;
  modelName: string;
  /** Boosts the user has before this one is spent. */
  available: number;
}

/** A platform offer (`_meta["hybridai/boostOffer"]` on a tool result). */
export interface BoostOffer extends BoostPrompt {
  /** Opaque platform id; also the approval id the user answers. */
  id: string;
}

/** The user's answer, sent back on the repeated tool call. */
export interface BoostAnswer {
  offer: string;
  use: boolean;
}

const BOOST_CATEGORIES: readonly unknown[] = ['image', 'music', 'video'];
// The platform sends 32 hex chars (uuid4); the id must also survive being
// typed as one word in `/boost use <id>`.
const BOOST_OFFER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_MODEL_NAME_CHARS = 120;

export function parseBoostPrompt(value: unknown): BoostPrompt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { category, modelName, available } = value as Record<string, unknown>;
  if (!BOOST_CATEGORIES.includes(category)) return null;
  const name = typeof modelName === 'string' ? modelName.trim() : '';
  if (!name || name.length > MAX_MODEL_NAME_CHARS) return null;
  if (
    typeof available !== 'number' ||
    !Number.isSafeInteger(available) ||
    available < 0
  )
    return null;
  return { category: category as BoostCategory, modelName: name, available };
}

export function parseBoostOffer(value: unknown): BoostOffer | null {
  const prompt = parseBoostPrompt(value);
  if (!prompt) return null;
  const { id: rawId } = value as { id?: unknown };
  const id = typeof rawId === 'string' ? rawId : '';
  if (!BOOST_OFFER_ID_RE.test(id)) return null;
  return { id, ...prompt };
}
