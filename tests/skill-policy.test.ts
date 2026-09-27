import { expect, test } from 'vitest';
import YAML from 'yaml';

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

test.each([
  {
    name: 'a misspelled parameter',
    rule: { when: { predicate: 'skill.name', equal: 'pdf' }, action: 'allow' },
    problem: '"equal"',
  },
  {
    name: 'a misspelled parameter inside not',
    rule: {
      when: { not: { predicate: 'actor.role', equal: 'finance' } },
      action: 'deny',
    },
    problem: 'when.not',
  },
  {
    name: 'a misspelled when key',
    rule: { wehn: { predicate: 'skill.name', equals: 'pdf' }, action: 'allow' },
    problem: '"wehn"',
  },
  {
    name: 'an unknown predicate',
    rule: { when: { predicate: 'skill.nmae', equals: 'pdf' }, action: 'allow' },
    problem: '"skill.nmae"',
  },
  {
    name: 'an inherited predicate name',
    rule: { when: { predicate: 'constructor' }, action: 'allow' },
    problem: '"constructor"',
  },
  { name: 'a string when', rule: { when: 'always', action: 'allow' }, problem: '"always"' },
  { name: 'an empty when', rule: { when: null, action: 'allow' }, problem: 'null' },
  { name: 'an empty all list', rule: { when: { all: [] }, action: 'allow' }, problem: 'when.all' },
  {
    name: 'any given as a mapping',
    rule: {
      when: { any: { predicate: 'skill.name', equals: 'pdf' } },
      action: 'allow',
    },
    problem: 'when.any',
  },
  {
    name: 'two value parameters',
    rule: {
      when: { predicate: 'skill.name', equals: 'pdf', matches: '^p' },
      action: 'allow',
    },
    problem: 'equals and matches',
  },
  {
    name: 'an empty value',
    rule: { when: { predicate: 'skill.name', equals: ' ' }, action: 'allow' },
    problem: 'when.equals',
  },
  {
    name: 'an invalid regular expression',
    rule: { when: { predicate: 'skill.name', matches: '(' }, action: 'deny' },
    problem: 'when.matches',
  },
  {
    name: 'a non-numeric bound',
    rule: {
      when: { predicate: 'skill.quality_score', gte: 'high' },
      action: 'deny',
    },
    problem: 'when.gte',
  },
])('a skill rule with $name denies every skill and says why', ({
  rule,
  problem,
}) => {
  for (const skillName of ['pdf', 'docx']) {
    expect(decide(rule, skillName)).toMatchObject({
      decision: 'deny',
      action: {
        type: 'deny',
        reason: expect.stringMatching(/^Unreadable skill rule #1\b/),
      },
    });
    expect(decide(rule, skillName).action.reason).toContain(problem);
  }
});

test('rules before an unreadable skill rule still apply', () => {
  const { rules } = readSkillPolicyState({
    skill: {
      rules: [
        { when: { predicate: 'skill.name', equals: 'pdf' }, action: 'allow' },
        { when: { predicate: 'skill.name', equal: 'sap' }, action: 'deny' },
      ],
    },
  });

  expect(
    evaluateSkillPolicyAccess({ rules, agentId: 'main', skillName: 'pdf' })
      .decision,
  ).toBe('allow');
  expect(
    evaluateSkillPolicyAccess({ rules, agentId: 'main', skillName: 'docx' })
      .decision,
  ).toBe('deny');
});

test.each([
  {
    name: 'a when that contains itself',
    yaml: ['skill:', '  rules:', '    - action: allow', '      when: &loop', '        not: *loop'],
    decision: 'deny',
  },
  {
    name: 'one condition aliased twice',
    yaml: [
      'sap: &sap {predicate: skill.name, equals: pdf}',
      'skill:',
      '  rules:',
      '    - action: deny',
      '      when: {all: [*sap, *sap]}',
    ],
    decision: 'deny',
  },
])('$name decides $decision without overflowing', ({ yaml, decision }) => {
  const { rules } = readSkillPolicyState(YAML.parse(yaml.join('\n')));

  expect(
    evaluateSkillPolicyAccess({ rules, agentId: 'main', skillName: 'pdf' })
      .decision,
  ).toBe(decision);
});

test.each([
  { name: 'in', when: { predicate: 'skill.name', in: ['pdf', 'sap'] }, input: {}, decision: 'deny' },
  { name: 'oneOf', when: { predicate: 'skill.name', oneOf: 'sap' }, input: {}, decision: 'deny' },
  { name: 'matches', when: { predicate: 'skill.name', matches: '^s.p$' }, input: {}, decision: 'deny' },
  {
    name: 'a bare predicate on an empty field',
    when: { predicate: 'skill.category' },
    input: {},
    decision: 'allow',
  },
  {
    name: 'a bare predicate on a set field',
    when: { predicate: 'skill.category' },
    input: { category: 'finance' },
    decision: 'deny',
  },
  {
    name: 'comma-separated roles',
    when: { predicate: 'actor.role', includes: 'ops, finance' },
    input: { roles: ['finance'] },
    decision: 'deny',
  },
  {
    name: 'a capability list',
    when: { predicate: 'skill.capability', any: ['network'] },
    input: { capabilities: ['network'] },
    decision: 'deny',
  },
  {
    name: 'a score inside the bounds',
    when: { predicate: 'skill.quality_score', gte: 50, lt: '80' },
    input: { qualityScore: 60 },
    decision: 'deny',
  },
  {
    name: 'a score outside the bounds',
    when: { predicate: 'skill.quality_score', gte: 50, lt: '80' },
    input: { qualityScore: 90 },
    decision: 'allow',
  },
  {
    name: 'a numeric tenant id',
    when: { predicate: 'tenant.id', equals: 42 },
    input: { tenantId: '42' },
    decision: 'deny',
  },
])('an annotated deny rule with $name decides $decision', ({
  when,
  input,
  decision,
}) => {
  const { rules } = readSkillPolicyState({
    skill: {
      rules: [
        {
          id: 'annotated',
          description: 'readable rule',
          comment: 'owner: platform',
          managed_by_example: true,
          when,
          action: 'deny',
        },
      ],
    },
  });

  expect(
    evaluateSkillPolicyAccess({
      rules,
      agentId: 'main',
      skillName: 'sap',
      ...input,
    }).decision,
  ).toBe(decision);
});
