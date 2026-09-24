/**
 * JEV transport validates every dimension against our closed vocabulary.
 * It never decides disclosure eligibility; callers must authorize the input first.
 * Remote response bodies and errors are never logged or surfaced verbatim.
 */
import type { ChoiceDistribution } from './evaluator-contract.js';
import { routingTierCriteria, TIER_SELECTION_RULE } from './policy.js';
export interface ClassifierResponse {
  model: string;
  distributions: { tier: ChoiceDistribution };
  inputTokens: number;
  outputTokens: number;
}
export interface TypedClassifier {
  evaluate(input: {
    text: string;
    tiers: { name: string }[];
    model: string;
    signal: AbortSignal;
  }): Promise<ClassifierResponse>;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid-response');
  return value as Record<string, unknown>;
}
function probability(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  )
    throw new Error('invalid-response');
  return value;
}
export function parseJevResponse(
  value: unknown,
  tiers: { name: string }[],
): ClassifierResponse {
  const raw = record(value);
  if (
    typeof raw.model !== 'string' ||
    !/^[a-zA-Z0-9._-]{1,100}$/.test(raw.model)
  )
    throw new Error('invalid-response');
  const answers = record(raw.answers);
  const distributions = {} as ClassifierResponse['distributions'];
  for (const dimension of ['tier'] as const) {
    const answer = record(answers[dimension]);
    const labels = tiers.map((tier) => tier.name);
    const values = record(answer.probabilities);
    if (
      answer.type !== 'choice' ||
      typeof answer.choice !== 'string' ||
      !labels.includes(answer.choice) ||
      Object.keys(values).length !== labels.length
    )
      throw new Error('invalid-response');
    const probabilities = Object.fromEntries(
      labels.map((label) => [label, probability(values[label])]),
    );
    const sum = Object.values(probabilities).reduce((a, b) => a + b, 0);
    // Floating-point tolerance only, not probability renormalization.
    if (
      Math.abs(sum - 1) > 0.001 ||
      probabilities[answer.choice] < Math.max(...Object.values(probabilities))
    )
      throw new Error('invalid-response');
    distributions[dimension] = {
      choice: answer.choice,
      confidence: probability(answer.confidence),
      probabilities,
    };
  }
  const usage = record(raw.usage);
  for (const key of ['input_tokens', 'output_tokens'])
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)
      throw new Error('invalid-response');
  return {
    model: raw.model,
    distributions,
    inputTokens: usage.input_tokens as number,
    outputTokens: usage.output_tokens as number,
  };
}
export function createJevClassifier(
  apiKey: string,
  transport: typeof fetch = fetch,
): TypedClassifier {
  return {
    async evaluate({ text, model, signal, tiers }) {
      const questions = {
        tier: {
          type: 'choice',
          instructions: TIER_SELECTION_RULE,
          criteria: routingTierCriteria(tiers),
        },
      };
      const response = await transport('https://api.typesafe.ai/v1/systemone', {
        method: 'POST',
        redirect: 'error',
        signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model, state: text, questions }),
      });
      if (!response.ok) throw new Error(`provider-http-${response.status}`);
      const body = await response.text();
      if (body.length > 100000) throw new Error('invalid-response');
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error('invalid-response');
      }
      return parseJevResponse(parsed, tiers);
    },
  };
}
