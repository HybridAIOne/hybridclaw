import { describe, expect, test, vi } from 'vitest';

import { createModelTextDeltaForwarder } from '../container/src/model-text-deltas.js';

describe('container model text delta forwarding', () => {
  test('forwards provider deltas immediately without replaying the final text', () => {
    const emit = vi.fn();
    const stream = createModelTextDeltaForwarder({
      enabled: true,
      forwardLive: true,
      emit,
    });

    stream.onProviderDelta('Hello');
    expect(emit).toHaveBeenCalledWith('Hello');

    stream.onProviderDelta(' world');
    stream.emitFinalFallback('Hello world');

    expect(emit.mock.calls).toEqual([['Hello'], [' world']]);
  });

  test('emits the final response when the provider produced no text deltas', () => {
    const emit = vi.fn();
    const stream = createModelTextDeltaForwarder({
      enabled: true,
      forwardLive: true,
      emit,
    });

    stream.onProviderDelta('');
    stream.emitFinalFallback('Fallback response');

    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith('Fallback response');
  });

  test('keeps Ralph drafts buffered and emits only the classified final text', () => {
    const emit = vi.fn();
    const stream = createModelTextDeltaForwarder({
      enabled: true,
      forwardLive: false,
      emit,
    });

    stream.onProviderDelta('Draft <choice>STOP</choice>');
    expect(emit).not.toHaveBeenCalled();

    stream.emitFinalFallback('Draft');
    expect(emit).toHaveBeenCalledWith('Draft');
  });

  test('does not emit when text streaming is disabled', () => {
    const emit = vi.fn();
    const stream = createModelTextDeltaForwarder({
      enabled: false,
      forwardLive: true,
      emit,
    });

    stream.onProviderDelta('Hello');
    stream.emitFinalFallback('Hello');

    expect(emit).not.toHaveBeenCalled();
  });
});
