import { afterEach, expect, test } from 'vitest';

import {
  buildFeedbackTriggerHints,
  clearTurnToolErrors,
  detectUserFrustration,
  rememberTurnToolErrors,
} from '../src/gateway/feedback-triggers.js';

afterEach(() => {
  clearTurnToolErrors();
});

test('detectUserFrustration flags clear frustration and ignores neutral text', () => {
  expect(detectUserFrustration('wtf, this is so frustrating')).toBe(true);
  expect(detectUserFrustration("it doesn't work again???")).toBe(true);
  expect(detectUserFrustration('I already told you twice')).toBe(true);
  expect(detectUserFrustration('Das funktioniert einfach nicht, schon wieder')).toBe(true);
  expect(detectUserFrustration('Can you summarise the Q3 report?')).toBe(false);
  expect(detectUserFrustration('Thanks, that worked!')).toBe(false);
  expect(detectUserFrustration('')).toBe(false);
  expect(detectUserFrustration(null)).toBe(false);
});

test('tool-error hints fire once for the turn after failed tool calls', () => {
  rememberTurnToolErrors('session-a', [
    { name: 'web_fetch', isError: true },
    { name: 'bash', isError: false },
    { name: 'web_fetch', isError: true },
    { name: 'http_request', isError: true },
  ]);
  const first = buildFeedbackTriggerHints({ sessionId: 'session-a', userText: 'ok' });
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('2 failed tool calls');
  expect(first[0]).toContain('`web_fetch`');
  expect(first[0]).toContain('`http_request`');
  expect(first[0]).toContain('"tool_error"');

  expect(buildFeedbackTriggerHints({ sessionId: 'session-a', userText: 'ok' })).toEqual([]);
  expect(buildFeedbackTriggerHints({ sessionId: 'session-b', userText: 'ok' })).toEqual([]);
});

test('a clean turn clears the previous tool-error record', () => {
  rememberTurnToolErrors('session-c', [{ name: 'bash', isError: true }]);
  rememberTurnToolErrors('session-c', [{ name: 'bash', isError: false }]);
  expect(buildFeedbackTriggerHints({ sessionId: 'session-c', userText: 'fine' })).toEqual([]);
});

test('frustration and tool-error hints combine and name the trigger', () => {
  rememberTurnToolErrors('session-d', [{ name: 'memory', isError: true }]);
  const hints = buildFeedbackTriggerHints({
    sessionId: 'session-d',
    userText: 'why does this never work, seriously???',
  });
  expect(hints).toHaveLength(2);
  expect(hints[1]).toContain('"user_frustration"');
  expect(hints[1]).toContain('Do not draft feedback about the user');
});
