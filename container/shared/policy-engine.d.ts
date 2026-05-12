export type PolicyActionType =
  | 'allow'
  | 'block'
  | 'warn'
  | 'log'
  | 'transform'
  | (string & {});

export interface PolicyAction {
  type: PolicyActionType;
  reason?: string;
  [key: string]: unknown;
}

export type PolicyPredicateExpression =
  | { predicate: string; [key: string]: unknown }
  | { all: PolicyPredicateExpression[] }
  | { any: PolicyPredicateExpression[] }
  | { not: PolicyPredicateExpression };

export interface PolicyRule<Action = PolicyAction> {
  id?: string | undefined;
  description?: string | undefined;
  when?: PolicyPredicateExpression | PolicyPredicateExpression[] | undefined;
  action: Action;
  metadata?: Record<string, unknown> | undefined;
}

export type PolicyPredicate<Context> = (
  context: Context,
  params: Record<string, unknown>,
) => boolean;

export type PolicyPredicateRegistry<Context> = Record<
  string,
  PolicyPredicate<Context>
>;

export interface PolicyEvaluation<Action, Rule extends PolicyRule<Action>> {
  action: Action;
  matchedRule?: Rule | undefined;
  matchedRules: Rule[];
}

export function evaluatePolicyExpression<Context>(
  expression:
    | PolicyPredicateExpression
    | PolicyPredicateExpression[]
    | null
    | undefined,
  context: Context,
  predicates: PolicyPredicateRegistry<Context>,
): boolean;

export function evaluatePolicyRules<
  Context,
  Action,
  Rule extends PolicyRule<Action> = PolicyRule<Action>,
>(params: {
  rules: Rule[];
  context: Context;
  predicates: PolicyPredicateRegistry<Context>;
  defaultAction: Action;
  mode?: 'first' | 'all';
}): PolicyEvaluation<Action, Rule>;
