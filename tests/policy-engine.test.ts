import { expect, test } from 'vitest';
import {
  evaluateNetworkPolicyAccess,
  type NetworkRule,
} from '../src/policy/network-policy.js';
import {
  evaluatePolicyExpression,
  evaluatePolicyRules,
  type PolicyPredicateRegistry,
  type PolicyRule,
} from '../src/policy/policy-engine.js';

interface ExampleContext {
  agent: string;
  label: string;
  text: string;
}

const predicates: PolicyPredicateRegistry<ExampleContext> = {
  agent: (context, params) => context.agent === params.equals,
  label: (context, params) => context.label === params.equals,
  contains: (context, params) =>
    context.text.includes(String(params.value || '')),
};

test('policy expressions compose pluggable predicates', () => {
  const context = {
    agent: 'finance',
    label: 'confidential',
    text: 'contains account number',
  };

  expect(
    evaluatePolicyExpression(
      {
        all: [
          { predicate: 'agent', equals: 'finance' },
          {
            any: [
              { predicate: 'label', equals: 'confidential' },
              { predicate: 'contains', value: 'secret' },
            ],
          },
          { not: { predicate: 'contains', value: 'public' } },
        ],
      },
      context,
      predicates,
    ),
  ).toBe(true);
});

test('policy engine returns the first matching action by default', () => {
  const rules: PolicyRule<{ type: string; reason: string }>[] = [
    {
      id: 'leak-block',
      when: { predicate: 'label', equals: 'confidential' },
      action: { type: 'block', reason: 'NDA text' },
    },
    {
      id: 'finance-log',
      when: { predicate: 'agent', equals: 'finance' },
      action: { type: 'log', reason: 'finance audit trail' },
    },
  ];

  const evaluation = evaluatePolicyRules({
    rules,
    context: {
      agent: 'finance',
      label: 'confidential',
      text: 'quarterly forecast',
    },
    predicates,
    defaultAction: { type: 'warn', reason: 'default' },
  });

  expect(evaluation.action).toEqual({ type: 'block', reason: 'NDA text' });
  expect(evaluation.matchedRule?.id).toBe('leak-block');
});

test('network policy is evaluated as a policy-engine consumer', () => {
  const rules: NetworkRule[] = [
    {
      action: 'deny',
      host: 'api.github.com',
      port: 443,
      methods: ['POST'],
      paths: ['/repos/**'],
      agent: 'research',
    },
    {
      action: 'allow',
      host: 'github.com',
      port: '*',
      methods: ['*'],
      paths: ['/**'],
      agent: '*',
    },
  ];

  const denied = evaluateNetworkPolicyAccess({
    rules,
    defaultAction: 'deny',
    host: 'api.github.com',
    port: 443,
    method: 'POST',
    path: '/repos/openai/openai',
    agentId: 'research',
  });
  const allowed = evaluateNetworkPolicyAccess({
    rules,
    defaultAction: 'deny',
    host: 'api.github.com',
    port: 443,
    method: 'GET',
    path: '/repos/openai/openai',
    agentId: 'research',
  });

  expect(denied).toEqual({
    decision: 'deny',
    matchedRule: rules[0],
  });
  expect(allowed).toEqual({
    decision: 'allow',
    matchedRule: rules[1],
  });
});
