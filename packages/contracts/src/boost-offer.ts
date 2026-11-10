/**
 * Boost prompt wire data: what a pending approval carries when the question
 * is whether to spend one of the user's boosts.
 *
 * NOT the offer parsers (`@hybridclaw/shared/boost-offer`), which decide
 * whether a platform offer is well formed enough to become this prompt.
 */

export type BoostCategory = 'image' | 'music' | 'video';

/** What the app's boost popup shows; part of a pending approval. */
export interface BoostPrompt {
  category: BoostCategory;
  modelName: string;
  /** Boosts the user has before this one is spent. */
  available: number;
}
