import { expect, test } from 'vitest';

import {
  agentCvEquals,
  buildOptionalAgentPresentation,
  cloneAgentCv,
  normalizeAgentCv,
  validateAgentOrgChart,
} from '../src/agents/agent-types.js';
import {
  escalationChain,
  managerOf,
  peersOf,
} from '../src/agents/org-chart.js';

test('buildOptionalAgentPresentation includes only populated presentation fields', () => {
  expect(
    buildOptionalAgentPresentation('Charly', 'avatars/charly.png'),
  ).toEqual({
    displayName: 'Charly',
    imageAsset: 'avatars/charly.png',
  });
  expect(buildOptionalAgentPresentation('', '')).toEqual({});
  expect(
    buildOptionalAgentPresentation(undefined, 'avatars/charly.png'),
  ).toEqual({
    imageAsset: 'avatars/charly.png',
  });
});

test('normalizeAgentCv accepts a string asset pointer', () => {
  expect(normalizeAgentCv('agents/charly/CV.md')).toEqual({
    asset: 'agents/charly/CV.md',
  });
  expect(normalizeAgentCv('   ')).toBeUndefined();
});

test('normalizeAgentCv trims fields, dedupes capabilities, and drops empties', () => {
  expect(
    normalizeAgentCv({
      summary: '  Senior researcher  ',
      background: '',
      capabilities: [' research ', 'writing', 'research', '', 7],
      asset: ' agents/charly/CV.md ',
    }),
  ).toEqual({
    summary: 'Senior researcher',
    capabilities: ['research', 'writing'],
    asset: 'agents/charly/CV.md',
  });
});

test('normalizeAgentCv returns undefined for non-object, empty, or noise input', () => {
  expect(normalizeAgentCv(undefined)).toBeUndefined();
  expect(normalizeAgentCv(null)).toBeUndefined();
  expect(normalizeAgentCv(['array'])).toBeUndefined();
  expect(normalizeAgentCv({})).toBeUndefined();
  expect(
    normalizeAgentCv({ summary: '   ', capabilities: [] }),
  ).toBeUndefined();
});

test('cloneAgentCv produces an independent copy', () => {
  const original = {
    summary: 'Senior',
    capabilities: ['a', 'b'],
    asset: 'CV.md',
  };
  const copy = cloneAgentCv(original);
  expect(copy).toEqual(original);
  copy?.capabilities?.push('c');
  expect(original.capabilities).toEqual(['a', 'b']);
});

test('agentCvEquals compares structurally', () => {
  expect(agentCvEquals(undefined, undefined)).toBe(true);
  expect(
    agentCvEquals(
      { summary: 'a', capabilities: ['x', 'y'] },
      { summary: 'a', capabilities: ['x', 'y'] },
    ),
  ).toBe(true);
  expect(
    agentCvEquals(
      { summary: 'a', capabilities: ['x', 'y'] },
      { summary: 'a', capabilities: ['y', 'x'] },
    ),
  ).toBe(false);
  expect(agentCvEquals({ summary: 'a' }, { summary: 'b' })).toBe(false);
  expect(agentCvEquals({ summary: 'a' }, undefined)).toBe(false);
});

test('validateAgentOrgChart accepts tree-shaped reporting lines', () => {
  expect(() =>
    validateAgentOrgChart([
      { id: 'hq', role: 'Chief of Staff' },
      { id: 'support-lead', role: 'Support Lead', reportsTo: 'hq' },
      {
        id: 'support-tier-1',
        role: 'Support Specialist',
        reportsTo: 'support-lead',
        delegatesTo: ['support-tier-2'],
        peers: ['support-tier-2'],
      },
      {
        id: 'support-tier-2',
        role: 'Escalation Specialist',
        reportsTo: 'support-lead',
        peers: ['support-tier-1'],
      },
    ]),
  ).not.toThrow();
});

test('validateAgentOrgChart rejects reports_to cycles and dangling references', () => {
  expect(() =>
    validateAgentOrgChart([
      { id: 'alpha', reportsTo: 'beta' },
      { id: 'beta', reportsTo: 'alpha' },
    ]),
  ).toThrow('Agent reports_to cycle detected: alpha -> beta -> alpha.');

  expect(() =>
    validateAgentOrgChart([{ id: 'alpha', reportsTo: 'missing' }]),
  ).toThrow('Agent "alpha" reports_to references unknown agent "missing".');

  expect(() =>
    validateAgentOrgChart([{ id: 'alpha', delegatesTo: ['missing'] }]),
  ).toThrow('Agent "alpha" delegates_to references unknown agent "missing".');

  expect(() =>
    validateAgentOrgChart([{ id: 'alpha', peers: ['missing'] }]),
  ).toThrow('Agent "alpha" peers references unknown agent "missing".');
});

test('org-chart helpers resolve managers, peers, and escalation chains', () => {
  const agents = [
    { id: 'hq', role: 'Chief of Staff' },
    {
      id: 'support-lead',
      role: 'Support Lead',
      reportsTo: 'hq',
      peers: ['ops-lead'],
    },
    { id: 'ops-lead', role: 'Operations Lead', reportsTo: 'hq' },
    {
      id: 'support-tier-1',
      role: 'Support Specialist',
      reportsTo: 'support-lead',
      peers: ['support-tier-2'],
    },
    {
      id: 'support-tier-2',
      role: 'Escalation Specialist',
      reportsTo: 'support-lead',
    },
    {
      id: 'billing',
      role: 'Billing Specialist',
      reportsTo: 'support-lead',
      peers: ['support-tier-1'],
    },
  ];

  expect(managerOf('support-tier-1', agents)?.id).toBe('support-lead');
  expect(managerOf('hq', agents)).toBeNull();
  expect(managerOf('missing', agents)).toBeNull();
  expect(peersOf('support-tier-1', agents).map((agent) => agent.id)).toEqual([
    'support-tier-2',
    'billing',
  ]);
  expect(
    escalationChain('support-tier-1', agents).map((agent) => agent.id),
  ).toEqual(['support-lead', 'hq']);
  expect(escalationChain('hq', agents)).toEqual([]);
});
