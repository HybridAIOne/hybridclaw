import { expect, test } from 'vitest';

import {
  evaluateSkillPolicyAccess,
  readSkillPolicyState,
} from '../src/policy/skill-policy.js';

const sapRule = (action: unknown) => ({
  id: 'sap-rule',
  when: { predicate: 'skill.name', equals: 'sap' },
  action,
});

function decide(rule: unknown, skillName = 'sap') {
  const { rules } = readSkillPolicyState({ skill: { rules: [rule] } });
  return evaluateSkillPolicyAccess({ rules, agentId: 'main', skillName });
}

test.each([
  { name: 'allow', rule: sapRule('allow'), decision: 'allow' },
  { name: 'typed deny', rule: sapRule({ type: 'deny' }), decision: 'deny' },
  { name: 'block', rule: sapRule('block'), decision: 'deny' },
  { name: 'typed " DENY "', rule: sapRule({ type: ' DENY ' }), decision: 'deny' },
  { name: 'warn', rule: sapRule({ type: 'warn' }), decision: 'allow' },
  { name: 'confirm-each', rule: sapRule('confirm-each'), decision: 'allow' },
  { name: 'typed denny', rule: sapRule({ type: 'denny' }), decision: 'deny' },
  { name: 'blokc', rule: sapRule('blokc'), decision: 'deny' },
  { name: 'no action', rule: sapRule(undefined), decision: 'deny' },
  { name: 'a bare string entry', rule: 'deny', decision: 'deny' },
])('skill rule with $name: $decision', ({ rule, decision }) => {
  expect(decide(rule).decision).toBe(decision);
});

test('an unreadable skill rule denies only the skills it names and says why', () => {
  expect(decide(sapRule({ type: 'denny' }))).toMatchObject({
    decision: 'deny',
    matchedRule: { id: 'sap-rule' },
    action: { type: 'deny', reason: expect.stringContaining('#1') },
  });
  expect(decide(sapRule({ type: 'denny' }), 'pdf').decision).toBe('allow');
});
