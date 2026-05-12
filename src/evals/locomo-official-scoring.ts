import { stemmer } from 'stemmer';

const PUNCTUATION_REGEX = /[!"#$%&'()*+./:;<=>?@[\\\]^_`{|}~-]/g;
const ARTICLES_REGEX = /\b(a|an|the|and)\b/g;

export function scoreOfficialLocomoAnswer(params: {
  category: number;
  prediction: string;
  answer: string;
}): number {
  const { category, prediction, answer } = params;
  if (category === 1) {
    return roundMetric(multiAnswerF1(prediction, answer));
  }
  if (category === 2 || category === 4) {
    return roundMetric(singleAnswerF1(prediction, answer));
  }
  if (category === 3) {
    return roundMetric(singleAnswerF1(prediction, answer.split(';')[0] || ''));
  }
  if (category === 5) {
    const normalized = prediction.toLowerCase();
    return normalized.includes('no information available') ||
      normalized.includes('not mentioned')
      ? 1
      : 0;
  }
  throw new Error(`Unsupported LOCOMO question category: ${category}`);
}

function normalizeAnswer(value: string): string {
  return String(value || '')
    .replace(/,/g, '')
    .toLowerCase()
    .replace(PUNCTUATION_REGEX, '')
    .replace(ARTICLES_REGEX, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .join(' ');
}

function stemTokens(value: string): string[] {
  return normalizeAnswer(value)
    .split(' ')
    .filter(Boolean)
    .map((token) => stemmer(token));
}

function singleAnswerF1(prediction: string, groundTruth: string): number {
  const predictionTokens = stemTokens(prediction);
  const groundTruthTokens = stemTokens(groundTruth);
  if (predictionTokens.length === 0 || groundTruthTokens.length === 0) {
    return 0;
  }

  const groundTruthCounts = new Map<string, number>();
  for (const token of groundTruthTokens) {
    groundTruthCounts.set(token, (groundTruthCounts.get(token) || 0) + 1);
  }

  let commonCount = 0;
  for (const token of predictionTokens) {
    const remaining = groundTruthCounts.get(token) || 0;
    if (remaining <= 0) continue;
    commonCount += 1;
    groundTruthCounts.set(token, remaining - 1);
  }

  if (commonCount === 0) return 0;
  const precision = commonCount / predictionTokens.length;
  const recall = commonCount / groundTruthTokens.length;
  return (2 * precision * recall) / (precision + recall);
}

function multiAnswerF1(prediction: string, groundTruth: string): number {
  const predictions = splitAnswers(prediction);
  const groundTruths = splitAnswers(groundTruth);
  if (predictions.length === 0 || groundTruths.length === 0) {
    return 0;
  }

  let total = 0;
  for (const truth of groundTruths) {
    let best = 0;
    for (const candidate of predictions) {
      best = Math.max(best, singleAnswerF1(candidate, truth));
    }
    total += best;
  }
  return total / groundTruths.length;
}

function splitAnswers(value: string): string[] {
  return String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function roundMetric(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000) / 1000;
}

export const testOnlyLocomoOfficialScoring = {
  normalizeAnswer,
  singleAnswerF1,
  multiAnswerF1,
};
