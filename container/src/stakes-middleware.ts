import type {
  ClassifierMiddlewareSkill,
  MiddlewareDecision,
} from './middleware-contract.js';
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
): ClassifierMiddlewareSkill<StakesClassificationInput> {
  return {
    id: 'stakes',
    priority: 0,
    pre_send(context) {
      return classifyStakesMiddleware(context, classifier).decision;
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

export function evaluateStakesMiddleware(
  context: StakesClassificationInput,
  classifier: StakesClassifier,
): StakesMiddlewareResult {
  return classifyStakesMiddleware(context, classifier);
}
