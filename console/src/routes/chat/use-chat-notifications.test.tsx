/** Notification delivery tests keep unread state independent of browser permission.
 * They exercise UI reactions, not external push-service delivery. */
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { WebNotificationState } from '../../../../container/shared/web-notifications.js';
import { useChatNotifications } from './use-chat-notifications';

const requestJson = vi.fn();
const enablePush = vi.fn();
const disablePush = vi.fn();
vi.mock('../../api/client', () => ({
  requestHeaders: () => ({}),
  requestJson: (...args: unknown[]) => requestJson(...args),
}));
vi.mock('../../lib/web-push', () => ({
  enableWebPush: (...args: unknown[]) => enablePush(...args),
  disableWebPush: (...args: unknown[]) => disablePush(...args),
}));

let enqueue: (state: WebNotificationState) => void;
let visible = false;
let permission: NotificationPermission;
const requestPermission = vi.fn();
const notification = vi.fn(function (this: {
  onclick: (() => void) | null;
  close: () => void;
}) {
  this.onclick = null;
  this.close = vi.fn();
});
const snapshot = (sessions: string[] = []): WebNotificationState => ({
  operatorId: 'operator-a',
  preferences: { turn: true, reminder: true, approval: true },
  notifications: sessions.map((sessionId, index) => ({
    id: `${sessionId}:${index}`,
    sessionId,
    agentId: 'agent-a',
    kind: 'reminder',
    title: 'Reminder',
    createdAt: Date.now(),
  })),
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('hybridclaw.notifications.enabled', 'true');
  permission = 'granted';
  visible = false;
  window.history.replaceState(null, '', '/chat/session-a');
  document.title = 'HybridClaw Chat';
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => (visible ? 'visible' : 'hidden'),
  });
  Object.defineProperty(notification, 'permission', {
    configurable: true,
    get: () => permission,
  });
  Object.assign(notification, { requestPermission });
  vi.stubGlobal('Notification', notification);
  vi.stubGlobal('isSecureContext', true);
  vi.spyOn(window, 'focus').mockImplementation(() => {});
  requestJson.mockResolvedValue({ ok: true });
  requestPermission.mockResolvedValue('granted');
  enablePush.mockRejectedValue(new Error('Push unavailable'));
  const body = new ReadableStream({
    start(controller) {
      enqueue = (state) =>
        controller.enqueue(
          new TextEncoder().encode(
            `event: notifications\ndata: ${JSON.stringify(state)}\n\n`,
          ),
        );
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mount() {
  const onOpenSession = vi.fn();
  const onMessage = vi.fn();
  const hook = renderHook(
    ({ sessionId }) =>
      useChatNotifications({
        token: 'test-token',
        enabled: true,
        sessionId,
        onOpenSession,
        onMessage,
      }),
    { initialProps: { sessionId: 'session-a' } },
  );
  return { ...hook, onOpenSession, onMessage };
}

test('background reminders update unread badges and title, alert once and focus the correct conversation', async () => {
  const hook = mount();
  await act(async () => enqueue(snapshot()));
  await act(async () => enqueue(snapshot(['session-a', 'session-b'])));
  expect(hook.result.current.unreadSessions).toEqual(
    new Set(['session-a', 'session-b']),
  );
  expect(document.title).toBe('(2) HybridClaw Chat');
  expect(notification).toHaveBeenCalledTimes(2);
  const instance = notification.mock.instances[1] as unknown as Notification;
  act(() => instance.onclick?.call(instance, new Event('click')));
  expect(window.focus).toHaveBeenCalled();
  expect(hook.onOpenSession).toHaveBeenCalledWith('session-b');
  await act(async () => enqueue(snapshot(['session-a', 'session-b'])));
  expect(notification).toHaveBeenCalledTimes(2);
  hook.unmount();
  expect(document.title).toBe('HybridClaw Chat');
});

test('denied permission still shows unread and only acknowledges the visible conversation', async () => {
  permission = 'denied';
  const hook = mount();
  await act(async () => enqueue(snapshot()));
  await act(async () => enqueue(snapshot(['session-a', 'session-b'])));
  expect(notification).not.toHaveBeenCalled();
  expect(hook.result.current.unreadSessions.size).toBe(2);
  act(() => {
    visible = true;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  expect(requestJson).toHaveBeenCalledWith(
    '/api/push/read',
    expect.objectContaining({ body: { ids: ['session-a:0'] } }),
  );
  hook.rerender({ sessionId: 'session-b' });
  expect(requestJson).toHaveBeenCalledWith(
    '/api/push/read',
    expect.objectContaining({ body: { ids: ['session-b:1'] } }),
  );
});

test('defers history refresh until streaming has reconciled the assistant reply', async () => {
  const onMessage = vi.fn();
  const hook = renderHook(
    ({ streamingSessionId }) =>
      useChatNotifications({
        token: 'test-token',
        enabled: true,
        sessionId: 'session-a',
        streamingSessionId,
        onOpenSession: vi.fn(),
        onMessage,
      }),
    { initialProps: { streamingSessionId: 'session-a' as string | null } },
  );
  await act(async () => enqueue(snapshot(['session-a'])));
  expect(onMessage).not.toHaveBeenCalled();
  hook.rerender({ streamingSessionId: null });
  expect(onMessage).toHaveBeenCalledWith('session-a');
});

test('clears the previous operator unread state immediately when credentials change', async () => {
  const hook = renderHook(
    ({ token }) =>
      useChatNotifications({
        token,
        enabled: true,
        sessionId: 'session-a',
        onOpenSession: vi.fn(),
        onMessage: vi.fn(),
      }),
    { initialProps: { token: 'operator-a-token' } },
  );
  await act(async () => enqueue(snapshot(['session-a'])));
  expect(hook.result.current.unreadSessions.size).toBe(1);
  hook.rerender({ token: 'operator-b-token' });
  expect(hook.result.current.state).toBeNull();
  expect(hook.result.current.unreadSessions.size).toBe(0);
});

test('permission is requested only by the explicit enable control and push avoids duplicate desktop alerts', async () => {
  localStorage.clear();
  permission = 'default';
  enablePush.mockResolvedValue(undefined);
  const hook = mount();
  await act(async () => enqueue(snapshot()));
  expect(requestPermission).not.toHaveBeenCalled();
  permission = 'granted';
  await act(async () => hook.result.current.toggle());
  expect(requestPermission).toHaveBeenCalledOnce();
  await waitFor(() => expect(hook.result.current.pushEnabled).toBe(true));
  await act(async () => enqueue(snapshot(['session-a'])));
  expect(notification).not.toHaveBeenCalled();
  expect(hook.onMessage).toHaveBeenCalledWith('session-a');
  await act(async () => hook.result.current.toggle());
  expect(disablePush).toHaveBeenCalledWith('test-token');
});
