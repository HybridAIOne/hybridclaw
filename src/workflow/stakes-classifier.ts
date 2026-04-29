import type {
  StakesClassificationInput,
  StakesClassifier,
  StakesLevel,
  StakesScore,
  StakesSignal,
} from '../../container/shared/stakes-classifier.js';
import { WORKFLOW_STAKES_ORDER } from './schema.js';

const CUSTOMER_FACING_RE =
  /\b(customer|client|external|public|publish|recipient|subscriber|prospect|lead|buyer)\b/i;
const SENSITIVE_RE =
  /\b(secret|token|password|credential|api[_ -]?key|private|nda|contract|legal|billing|payment|refund|charge|production|live)\b/i;
const IRREVERSIBLE_RE =
  /\b(delete|destroy|drop|truncate|erase|wipe|terminate|cancel|publish|send|charge|refund|transfer)\b/i;

function maxLevel(...levels: StakesLevel[]): StakesLevel {
  return levels.reduce<StakesLevel>(
    (max, level) =>
      WORKFLOW_STAKES_ORDER[level] > WORKFLOW_STAKES_ORDER[max] ? level : max,
    'low',
  );
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function signal(
  name: string,
  level: StakesLevel,
  score: number,
  reason: string,
): StakesSignal {
  return { name, level, score: clamp01(score), reason };
}

export class WorkflowStakesClassifier implements StakesClassifier {
  classify(input: StakesClassificationInput): StakesScore {
    const text = [
      input.toolName,
      input.actionKey,
      input.intent,
      input.reason,
      input.target,
      JSON.stringify(input.args),
    ]
      .join(' ')
      .toLowerCase();
    const signals: StakesSignal[] = [];

    if (input.writeIntent) {
      signals.push(
        signal(
          'workflow-write',
          'medium',
          0.2,
          'workflow step can modify state',
        ),
      );
    }
    if (CUSTOMER_FACING_RE.test(text)) {
      signals.push(
        signal(
          'customer-facing',
          input.writeIntent ? 'high' : 'medium',
          input.writeIntent ? 0.5 : 0.35,
          'step appears customer-facing or externally visible',
        ),
      );
    }
    if (SENSITIVE_RE.test(text)) {
      signals.push(
        signal(
          'sensitive-context',
          'high',
          0.55,
          'step mentions sensitive, legal, billing, or production context',
        ),
      );
    }
    if (IRREVERSIBLE_RE.test(text)) {
      signals.push(
        signal(
          'irreversible',
          'high',
          0.65,
          'step appears irreversible or difficult to roll back',
        ),
      );
    }

    const score = clamp01(
      0.05 + signals.reduce((total, entry) => total + entry.score, 0),
    );
    const level = maxLevel(
      score >= 0.75 ? 'high' : score >= 0.35 ? 'medium' : 'low',
      ...signals.map((entry) => entry.level),
    );
    const reasons =
      signals.length > 0
        ? [...new Set(signals.map((entry) => entry.reason))]
        : ['no elevated-stakes workflow signals detected'];

    return {
      level,
      score,
      confidence: clamp01(0.65 + Math.min(signals.length, 3) * 0.08),
      classifier: 'workflow-f8-rules:v1',
      signals,
      reasons,
    };
  }
}

export function createWorkflowStakesClassifier(): StakesClassifier {
  return new WorkflowStakesClassifier();
}
