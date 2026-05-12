import type {
  ClassifierMiddlewareSkill,
  MiddlewareDecision,
} from '../shared/middleware-contract.js';
import {
  classifyStakes,
  type StakesClassificationInput,
  type StakesClassifier,
  type StakesScore,
} from './stakes-classifier.js';

export interface StakesMiddlewareResult {
  decision: MiddlewareDecision;
  stakesScore: StakesScore;
}

export type StakesMiddlewareContext = StakesClassificationInput & {
  recordStakesScore?: (score: StakesScore) => void;
};

function decisionForStakes(score: StakesScore): MiddlewareDecision {
  const reason =
    score.reasons.length > 0
      ? score.reasons.join('; ')
      : `${score.level} stakes via ${score.classifier}`;
  if (score.level === 'high') {
    return {
      action: 'escalate',
      route: 'approval_request',
      reason,
    };
  }
  if (score.level === 'medium') {
    return {
      action: 'warn',
      reason,
    };
  }
  return { action: 'allow' };
}

export function createStakesMiddlewareSkill(
  classifier: StakesClassifier,
): ClassifierMiddlewareSkill<StakesMiddlewareContext> {
  return {
    id: 'stakes',
    pre_send(context) {
      const result = classifyStakesMiddleware(context, classifier);
      context.recordStakesScore?.(result.stakesScore);
      return result.decision;
    },
  };
}

function classifyStakesMiddleware(
  context: StakesClassificationInput,
  classifier: StakesClassifier,
): StakesMiddlewareResult {
  const stakesScore = classifyStakes(context, classifier);
  return {
    decision: decisionForStakes(stakesScore),
    stakesScore,
  };
}
