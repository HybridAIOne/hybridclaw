import { expect, test } from 'vitest';

import { classifyGatewayError } from '../src/gateway/gateway-error-utils.ts';

test('classifyGatewayError marks merged transient patterns as transient', () => {
  expect(
    classifyGatewayError('request timed out while waiting for upstream'),
  ).toBe('transient');
  expect(
    classifyGatewayError('connection reset by peer, please try again'),
  ).toBe('transient');
  expect(classifyGatewayError('API error: terminated')).toBe('transient');
});

test('classifyGatewayError marks permanent auth and policy failures as permanent', () => {
  expect(classifyGatewayError('invalid api key for selected provider')).toBe(
    'permanent',
  );
  expect(classifyGatewayError('blocked by security hook policy')).toBe(
    'permanent',
  );
});

test('classifyGatewayError falls back to unknown for unmatched text', () => {
  expect(classifyGatewayError('model returned malformed delegation plan')).toBe(
    'unknown',
  );
});
