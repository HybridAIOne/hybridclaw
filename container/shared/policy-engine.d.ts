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
  id?: string;
  description?: string;
  when?: PolicyPredicateExpression | PolicyPredicateExpression[];
  action: Action;
  metadata?: Record<string, unknown>;
}

export type PolicyPredicate<Context> = (
  context: Context,
  params: Record<string, unknown>,
) => boolean;

export type PolicyPredicateRegistry<Context> = Record<
  string,
  PolicyPredicate<Context>
>;

export interface PolicyParameterSpec {
  /** Why a value cannot be read, or '' when it can. */
  check: (value: unknown) => string;
  /** Parameters in one group are spellings of one parameter: set at most one. */
  group?: string;
  /** A predicate node must set this parameter. */
  required?: boolean;
}

/** Each predicate's parameters, as the evaluator reads them. */
export type PolicyPredicateParameters = Record<
  string,
  Record<string, PolicyParameterSpec>
>;

export interface PolicyEvaluation<Action, Rule extends PolicyRule<Action>> {
  action: Action;
  matchedRule?: Rule;
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

export function checkPolicyText(value: unknown): string;

/** Why a user-authored rule is unreadable, or '' when it is readable. */
export function describePolicyRuleProblem(
  rule: unknown,
  predicates: PolicyPredicateParameters,
): string;
