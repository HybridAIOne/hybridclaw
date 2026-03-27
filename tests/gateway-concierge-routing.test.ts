import { expect, test } from 'vitest';
import type { RuntimeConfig } from '../src/config/runtime-config.js';
import {
  buildConciergeQuestion,
  buildConciergeResumePrompt,
  inferPromptUrgencyProfile,
  parseConciergeChoice,
  parseConciergeDecision,
  resolveConciergeProfileModel,
  shouldTriggerConcierge,
} from '../src/gateway/concierge-routing.js';

test('shouldTriggerConcierge flags long-form artifact requests', () => {
  expect(
    shouldTriggerConcierge('Can you create a marketing plan as PDF for Q3?'),
  ).toBe(true);
  expect(shouldTriggerConcierge('hi')).toBe(false);
});

test('parseConciergeDecision accepts ask_user and pick_profile payloads', () => {
  expect(parseConciergeDecision('{"decision":"ask_user"}')).toEqual({
    kind: 'ask_user',
  });
  expect(
    parseConciergeDecision('{"decision":"pick_profile","profile":"no_hurry"}'),
  ).toEqual({
    kind: 'pick_profile',
    profile: 'no_hurry',
  });
  expect(parseConciergeDecision('{"decision":"maybe"}')).toBeNull();
});

test('parseConciergeChoice maps numeric replies', () => {
  expect(parseConciergeChoice('1')).toBe('asap');
  expect(parseConciergeChoice('2')).toBe('balanced');
  expect(parseConciergeChoice('3')).toBe('no_hurry');
  expect(parseConciergeChoice('later')).toBeNull();
});

test('inferPromptUrgencyProfile detects explicit urgency phrases', () => {
  expect(inferPromptUrgencyProfile('I need this ASAP')).toBe('asap');
  expect(inferPromptUrgencyProfile('No hurry on this one')).toBe('no_hurry');
  expect(inferPromptUrgencyProfile('this is ordinary')).toBeNull();
});

test('buildConcierge helpers render stable question and resume prompt', () => {
  expect(buildConciergeQuestion()).toContain('1) As soon as possible');
  expect(buildConciergeQuestion({ invalidChoice: true })).toContain(
    'Please reply with 1, 2, or 3.',
  );
  expect(buildConciergeResumePrompt('Create a deck', 'balanced')).toContain(
    'User selected: Can wait a bit',
  );
});

test('resolveConciergeProfileModel reads the configured mapping', () => {
  const config = {
    routing: {
      concierge: {
        profiles: {
          asap: 'gpt-5',
          balanced: 'gpt-5-mini',
          noHurry: 'ollama/qwen3:latest',
        },
      },
    },
  } as RuntimeConfig;

  expect(resolveConciergeProfileModel(config, 'asap')).toBe('gpt-5');
  expect(resolveConciergeProfileModel(config, 'balanced')).toBe('gpt-5-mini');
  expect(resolveConciergeProfileModel(config, 'no_hurry')).toBe(
    'ollama/qwen3:latest',
  );
});
