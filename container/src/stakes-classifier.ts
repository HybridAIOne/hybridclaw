import type {
  StakesClassificationInput,
  StakesClassifier,
  StakesLevel,
  StakesScore,
  StakesSignal,
} from '../shared/stakes-classifier.js';
import { normalizeText } from './text-normalization.js';

export type {
  StakesApprovalTier,
  StakesClassificationInput,
  StakesClassifier,
  StakesLevel,
  StakesScore,
  StakesSignal,
} from '../shared/stakes-classifier.js';

export interface RuleBasedStakesClassifierOptions {
  mediumCostEur?: number;
  highCostEur?: number;
  classifierName?: string;
}

export interface MlStakesClassifier {
  classify(input: StakesClassificationInput): unknown;
}

export interface StakesClassifierOptions {
  ruleOptions?: RuleBasedStakesClassifierOptions;
  mlClassifier?: MlStakesClassifier | null;
  minMlConfidence?: number;
}

const STAKES_ORDER: Record<StakesLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

const DEFAULT_MEDIUM_COST_EUR = 50;
const DEFAULT_HIGH_COST_EUR = 500;
const DEFAULT_ML_MIN_CONFIDENCE = 0.55;
const MAX_COST_AMOUNT_DEPTH = 10;
const COST_KEY_RE =
  /\b(cost|price|amount|budget|spend|charge|payment|refund|invoice|revenue|expense|salary|fee|subscription|order[_ -]?value)\b/i;
const CUSTOMER_FACING_RE =
  /\b(customer|client|external|public|user|recipient|audience|subscriber|prospect|lead|buyer|patient|tenant)\b/i;
const CUSTOMER_CHANNEL_RE =
  /\b(email|sms|whatsapp|telegram|slack|discord|msteams|teams|imessage|post|publish|tweet|dm|recipient|to|cc|bcc)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const IRREVERSIBLE_RE =
  /\b(rm\s+-rf|delete|destroy|drop\s+table|truncate|erase|wipe|terminate|cancel|void|refund|charge|transfer|revoke|disable|force\s+push|git\s+push\s+--force)\b/i;
const PRODUCTION_RE =
  /\b(prod|production|live|deploy|release|billing|payment|payroll|invoice|database|migration|customer\s+data)\b/i;
const SECRET_RE =
  /\b(secret|token|password|credential|api[_ -]?key|private[_ -]?key|\.env|ssh\/|\/etc\/)\b/i;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function maxStakesLevel(...levels: StakesLevel[]): StakesLevel {
  let max: StakesLevel = 'low';
  for (const level of levels) {
    if (STAKES_ORDER[level] > STAKES_ORDER[max]) max = level;
  }
  return max;
}

function levelForScore(score: number): StakesLevel {
  if (score >= 0.75) return 'high';
  if (score >= 0.35) return 'medium';
  return 'low';
}

function normalizeStakesLevel(value: unknown): StakesLevel | null {
  if (value === 'low' || value === 'medium' || value === 'high') return value;
  return null;
}

function stringifyForInspection(input: StakesClassificationInput): string {
  return [
    input.toolName,
    input.actionKey,
    input.intent,
    input.reason,
    input.target,
    JSON.stringify(input.args),
    input.pathHints.join(' '),
    input.hostHints.join(' '),
  ]
    .map(normalizeText)
    .filter(Boolean)
    .join(' ');
}

function parseAmount(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let normalized = trimmed.replace(/[^\d,.-]/g, '');
  const lastComma = normalized.lastIndexOf(',');
  const lastDot = normalized.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) {
      normalized = normalized.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = normalized.replace(/,/g, '');
    }
  } else if (lastComma >= 0) {
    const decimals = normalized.length - lastComma - 1;
    normalized =
      decimals === 2
        ? normalized.replace(',', '.')
        : normalized.replace(/,/g, '');
  }

  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? Math.abs(parsed) : null;
}

function extractCurrencyAmounts(text: string): number[] {
  const amounts: number[] = [];
  const currencyRe =
    /(?:€|\$|£|\b(?:eur|usd|gbp)\b)\s*(-?\d[\d.,]*)|(-?\d[\d.,]*)\s*(?:€|\$|£|\b(?:eur|usd|gbp)\b)/gi;
  for (const match of text.matchAll(currencyRe)) {
    const amount = parseAmount(match[1] || match[2] || '');
    if (amount != null) amounts.push(amount);
  }
  return amounts;
}

function collectCostAmounts(value: unknown, keyHint = '', depth = 0): number[] {
  if (depth > MAX_COST_AMOUNT_DEPTH) return [];
  const amounts: number[] = [];
  const keyLooksCostly = COST_KEY_RE.test(keyHint);

  if (typeof value === 'number') {
    if (keyLooksCostly && Number.isFinite(value)) amounts.push(Math.abs(value));
    return amounts;
  }

  if (typeof value === 'string') {
    amounts.push(...extractCurrencyAmounts(value));
    if (keyLooksCostly) {
      const plainAmount = parseAmount(value);
      if (plainAmount != null) amounts.push(plainAmount);
    }
    return amounts;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      amounts.push(...collectCostAmounts(entry, keyHint, depth + 1));
    }
    return amounts;
  }

  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      amounts.push(...collectCostAmounts(entry, key, depth + 1));
    }
  }

  return amounts;
}

function uniqueReasons(signals: StakesSignal[]): string[] {
  return [...new Set(signals.map((signal) => signal.reason))];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeMlScore(score: unknown): StakesScore | null {
  if (!isRecord(score)) return null;
  const level = normalizeStakesLevel(score.level);
  if (!level) return null;
  const signals = Array.isArray(score.signals)
    ? score.signals.map((signal) => {
        const record = isRecord(signal) ? signal : {};
        return {
          name: normalizeText(record.name) || 'ml',
          level: normalizeStakesLevel(record.level) || level,
          score: clamp01(Number(record.score)),
          reason: normalizeText(record.reason) || 'ML classifier signal',
        };
      })
    : [];
  const reasons = Array.isArray(score.reasons)
    ? score.reasons.map(normalizeText).filter(Boolean)
    : uniqueReasons(signals);
  return {
    level,
    score: clamp01(Number(score.score)),
    confidence: clamp01(Number(score.confidence)),
    classifier: normalizeText(score.classifier) || 'ml',
    signals,
    reasons,
  };
}

function resolveCostThreshold(
  name: 'mediumCostEur' | 'highCostEur',
  value: unknown,
  fallback: number,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive finite number`);
  }
  return value;
}

export class RuleBasedStakesClassifier implements StakesClassifier {
  private readonly mediumCostEur: number;
  private readonly highCostEur: number;
  private readonly classifierName: string;

  constructor(options: RuleBasedStakesClassifierOptions = {}) {
    this.mediumCostEur = resolveCostThreshold(
      'mediumCostEur',
      options.mediumCostEur,
      DEFAULT_MEDIUM_COST_EUR,
    );
    this.highCostEur = resolveCostThreshold(
      'highCostEur',
      options.highCostEur,
      DEFAULT_HIGH_COST_EUR,
    );
    this.classifierName = options.classifierName || 'rules:v1';
  }

  classify(input: StakesClassificationInput): StakesScore {
    const text = stringifyForInspection(input);
    const signals: StakesSignal[] = [];
    const addSignal = (
      name: string,
      level: StakesLevel,
      score: number,
      reason: string,
    ): void => {
      signals.push({ name, level, score: clamp01(score), reason });
    };

    if (input.approvalTier === 'red') {
      addSignal(
        'approval-tier:red',
        'high',
        0.7,
        'approval rules marked the action high risk',
      );
    } else if (input.approvalTier === 'yellow') {
      addSignal(
        'approval-tier:yellow',
        'medium',
        0.3,
        'approval rules marked the action as side-effecting or external',
      );
    }

    if (input.pinned) {
      addSignal(
        'pinned-sensitive',
        'high',
        0.75,
        'policy pinned the target as sensitive',
      );
    }

    if (input.writeIntent) {
      addSignal('write-intent', 'medium', 0.15, 'the action can modify state');
    }

    const maxCost = Math.max(0, ...collectCostAmounts(input.args));
    if (maxCost >= this.highCostEur) {
      addSignal(
        'cost:high',
        'high',
        0.85,
        `detected cost exposure >= EUR ${this.highCostEur}`,
      );
    } else if (maxCost >= this.mediumCostEur) {
      addSignal(
        'cost:medium',
        'medium',
        0.45,
        `detected cost exposure >= EUR ${this.mediumCostEur}`,
      );
    }

    const customerFacing =
      CUSTOMER_FACING_RE.test(text) ||
      CUSTOMER_CHANNEL_RE.test(text) ||
      input.actionKey.startsWith('message:send');
    if (customerFacing) {
      addSignal(
        'customer-facing',
        input.writeIntent ? 'high' : 'medium',
        input.writeIntent ? 0.45 : 0.35,
        'target appears customer-facing or externally visible',
      );
    }

    if (IRREVERSIBLE_RE.test(text)) {
      addSignal(
        'irreversible',
        'high',
        0.8,
        'action appears irreversible or difficult to roll back',
      );
    }

    if (PRODUCTION_RE.test(text)) {
      addSignal(
        'production',
        input.writeIntent ? 'high' : 'medium',
        input.writeIntent ? 0.45 : 0.3,
        'target appears production, billing, or live data related',
      );
    }

    if (SECRET_RE.test(text)) {
      addSignal(
        'sensitive-data',
        'high',
        0.65,
        'target mentions secrets, credentials, or sensitive system paths',
      );
    }

    const score = clamp01(
      0.05 + signals.reduce((total, signal) => total + signal.score, 0),
    );
    const level = maxStakesLevel(
      levelForScore(score),
      ...signals.map((signal) => signal.level),
    );
    const confidence = clamp01(0.65 + Math.min(signals.length, 3) * 0.08);

    return {
      level,
      score,
      confidence,
      classifier: this.classifierName,
      signals,
      reasons:
        signals.length > 0
          ? uniqueReasons(signals)
          : ['no elevated-stakes signals detected'],
    };
  }
}

export class CompositeStakesClassifier implements StakesClassifier {
  private readonly ruleClassifier: RuleBasedStakesClassifier;
  private readonly mlClassifier: MlStakesClassifier | null;
  private readonly minMlConfidence: number;

  constructor(options: StakesClassifierOptions = {}) {
    this.ruleClassifier = new RuleBasedStakesClassifier(options.ruleOptions);
    this.mlClassifier = options.mlClassifier || null;
    this.minMlConfidence =
      typeof options.minMlConfidence === 'number'
        ? clamp01(options.minMlConfidence)
        : DEFAULT_ML_MIN_CONFIDENCE;
  }

  classify(input: StakesClassificationInput): StakesScore {
    const ruleScore = this.ruleClassifier.classify(input);
    const mlScore = this.mlClassifier
      ? normalizeMlScore(this.mlClassifier.classify(input))
      : null;
    if (!mlScore || mlScore.confidence < this.minMlConfidence) {
      return ruleScore;
    }

    const level = maxStakesLevel(ruleScore.level, mlScore.level);
    const score = Math.max(ruleScore.score, mlScore.score);
    return {
      level,
      score,
      confidence: Math.max(ruleScore.confidence, mlScore.confidence),
      classifier: `${ruleScore.classifier}+${mlScore.classifier}`,
      signals: [...ruleScore.signals, ...mlScore.signals],
      reasons: [...new Set([...ruleScore.reasons, ...mlScore.reasons])],
    };
  }
}

export function createStakesClassifier(
  options: StakesClassifierOptions = {},
): StakesClassifier {
  return new CompositeStakesClassifier(options);
}

export function classifyStakes(
  input: StakesClassificationInput,
  classifier: StakesClassifier,
): StakesScore {
  if (!classifier || typeof classifier.classify !== 'function') {
    throw new Error(
      'classifyStakes requires a configured StakesClassifier instance',
    );
  }
  return classifier.classify(input);
}
