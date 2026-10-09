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

export declare function parseBoostPrompt(value: unknown): BoostPrompt | null;

export declare function parseBoostOffer(value: unknown): BoostOffer | null;
