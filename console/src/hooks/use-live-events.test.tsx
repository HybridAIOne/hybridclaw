import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveEvents } from './use-live-events';

type Listener = (event: Event | MessageEvent<string>) => void;

class MockEventSource {
  static instances: MockEventSource[] = [];

  readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  close(): void {}

  emit(type: string, event: Event | MessageEvent<string>): void {
    for (const listener of this.listeners.get(type) || []) {
      listener(event);
    }
  }
}

function Probe(props: { token: string }) {
  const live = useLiveEvents(props.token);
  return <div>{live.connection}</div>;
}

describe('useLiveEvents', () => {
  beforeEach(() => {
    MockEventSource.instances = [];
    vi.stubGlobal('EventSource', MockEventSource);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the admin events stream without a token in localhost mode', async () => {
    render(<Probe token="" />);

    expect(MockEventSource.instances).toHaveLength(1);
    expect(MockEventSource.instances[0]?.url).toBe('/api/events');
    expect(screen.getByText('connecting')).not.toBeNull();

    await act(async () => {
      MockEventSource.instances[0]?.emit('open', new Event('open'));
    });

    expect(screen.getByText('open')).not.toBeNull();
  });
});
