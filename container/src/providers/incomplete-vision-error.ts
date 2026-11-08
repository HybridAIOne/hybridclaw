/**
 * A capped vision response is a failure even when it contains useful observations.
 * Visible partial text belongs in the tool result. Generic exception messages
 * and serialized errors never carry it or the provider's reasoning metadata.
 */
export class IncompleteVisionAnalysisError extends Error {
  readonly #partialAnalysis: string;

  constructor(partialAnalysis: string) {
    super(
      'vision API reached its output limit; analysis is incomplete. Ask about the missing details separately, or increase auxiliaryModels.vision.maxTokens for a longer analysis.',
    );
    this.#partialAnalysis = partialAnalysis;
  }

  get output(): string {
    return JSON.stringify({
      success: false,
      incomplete: true,
      error: this.message,
      ...(this.#partialAnalysis && { partial_analysis: this.#partialAnalysis }),
    });
  }
}
