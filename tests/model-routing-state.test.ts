import { afterEach, expect, test } from 'vitest';
import {
  clearStickyModelRoutingTier,
  consumeStickyModelRoutingTier,
  peekStickyModelRoutingTier,
  setStickyModelRoutingTier,
} from '../src/gateway/model-routing-state.js';

afterEach(() => clearStickyModelRoutingTier());

test('sticky routing is honored for its configured turn window then de-escalates', () => {
  setStickyModelRoutingTier('session-1', 'advanced', 3);
  expect(peekStickyModelRoutingTier('session-1')).toBe('advanced');
  expect(peekStickyModelRoutingTier('session-1')).toBe('advanced');
  expect(consumeStickyModelRoutingTier('session-1')).toBe('advanced');
  expect(consumeStickyModelRoutingTier('session-1')).toBe('advanced');
  expect(consumeStickyModelRoutingTier('session-1')).toBe('advanced');
  expect(consumeStickyModelRoutingTier('session-1')).toBeUndefined();
});
