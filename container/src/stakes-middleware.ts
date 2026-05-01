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

export interface StakesMiddlewareContext extends StakesClassificationInput {}

export interface StakesMiddlewareResult {
  decision: MiddlewareDecision;
  stakesScore: StakesScore;
}

export interface StakesClassifierMiddlewareSkill
  extends ClassifierMiddlewareSkill<StakesMiddlewareContext> {
  classify(context: StakesMiddlewareContext): StakesMiddlewareResult;
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
): StakesClassifierMiddlewareSkill {
  const classify = (
    context: StakesMiddlewareContext,
  ): StakesMiddlewareResult => {
    const stakesScore = classifyStakes(context, classifier);
    return {
      decision: decisionForStakes(stakesScore),
      stakesScore,
    };
  };

  return {
    id: 'stakes',
    priority: 0,
    pre_send(context) {
      return classify(context).decision;
    },
    classify,
  };
}

export function evaluateStakesMiddleware(
  context: StakesMiddlewareContext,
  classifier: StakesClassifier,
): StakesMiddlewareResult {
  return createStakesMiddlewareSkill(classifier).classify(context);
}
