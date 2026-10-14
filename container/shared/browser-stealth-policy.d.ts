import type { PolicyRule } from './policy-engine.js';

export type BrowserStealthPolicyDecision = 'allow' | 'deny';

export interface BrowserStealthPolicyContext {
  host: string;
  agentId?: string;
  skillName?: string;
}

export interface BrowserStealthPolicyState {
  rules: PolicyRule<BrowserStealthPolicyDecision>[];
}

export interface BrowserStealthPolicyAccessEvaluation {
  decision: BrowserStealthPolicyDecision;
  matchedRule?: PolicyRule<BrowserStealthPolicyDecision>;
}

export function readBrowserStealthPolicyStateFromDocument(
  document: Record<string, unknown>,
): BrowserStealthPolicyState;
export function evaluateBrowserStealthPolicyAccess(params: {
  state: BrowserStealthPolicyState;
  context: BrowserStealthPolicyContext;
}): BrowserStealthPolicyAccessEvaluation;
