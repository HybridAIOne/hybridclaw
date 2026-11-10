import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { MediaItem } from '../../api/chat-types';
import { useQueuedMessages } from './use-queued-messages';

const FILE: MediaItem = {
  path: '/uploads/a.png',
  mimeType: 'image/png',
  filename: 'a.png',
};

function setup(steerResults: boolean[], sessionId = 'session-a') {
  const steer = vi.fn(async () => steerResults.shift() ?? false);
  const send = vi.fn();
  const stop = vi.fn();
  const hook = renderHook(
    (props: { isStreaming: boolean; sessionId: string }) =>
      useQueuedMessages({ ...props, steer, send, stop }),
    { initialProps: { isStreaming: true, sessionId } },
  );
  const submit = async (content: string, media: MediaItem[] = []) => {
    await act(async () => {
      hook.result.current.submit(content, media);
    });
  };
  return { hook, steer, send, stop, submit };
}

describe('useQueuedMessages', () => {
  it('hands a message the running turn takes to it and queues nothing', async () => {
    const { hook, steer, send, submit } = setup([true]);
    await submit('also check the tests');
    expect(steer).toHaveBeenCalledWith('session-a', 'also check the tests');
    expect(hook.result.current.queued).toEqual([]);
    hook.rerender({ isStreaming: false, sessionId: 'session-a' });
    expect(send).not.toHaveBeenCalled();
  });

  it('queues a refused message and sends it once the reply ends', async () => {
    const { hook, send, submit } = setup([false]);
    await submit('next question');
    expect(hook.result.current.queued.map((m) => m.content)).toEqual([
      'next question',
    ]);
    expect(send).not.toHaveBeenCalled();
    hook.rerender({ isStreaming: false, sessionId: 'session-a' });
    expect(send).toHaveBeenCalledWith('next question', []);
    expect(hook.result.current.queued).toEqual([]);
  });

  it('keeps typed order: nothing steers past a waiting message', async () => {
    const { hook, steer, submit } = setup([false, true]);
    await submit('first');
    await submit('second');
    expect(steer).toHaveBeenCalledTimes(1);
    expect(hook.result.current.queued.map((m) => m.content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('queues attachments without steering, since notes carry only text', async () => {
    const { hook, steer, submit } = setup([true]);
    await submit('see this', [FILE]);
    expect(steer).not.toHaveBeenCalled();
    expect(hook.result.current.queued[0]?.media).toEqual([FILE]);
  });

  it('stops the run on /stop instead of queueing it', async () => {
    const { hook, steer, stop, submit } = setup([]);
    await submit('/stop');
    expect(stop).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
    expect(hook.result.current.queued).toEqual([]);
  });

  it('sends a queued message only from the session it was typed in', async () => {
    const { hook, send, submit } = setup([false]);
    await submit('for session a');
    hook.rerender({ isStreaming: false, sessionId: 'session-b' });
    expect(send).not.toHaveBeenCalled();
    expect(hook.result.current.queued).toEqual([]);
    hook.rerender({ isStreaming: false, sessionId: 'session-a' });
    expect(send).toHaveBeenCalledWith('for session a', []);
  });

  it('drops a removed message', async () => {
    const { hook, send, submit } = setup([false]);
    await submit('never mind');
    const id = hook.result.current.queued[0]?.id ?? '';
    act(() => hook.result.current.remove(id));
    hook.rerender({ isStreaming: false, sessionId: 'session-a' });
    expect(send).not.toHaveBeenCalled();
  });
});
