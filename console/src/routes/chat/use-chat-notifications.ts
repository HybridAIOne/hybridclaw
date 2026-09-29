/**
 * Unread state comes from the gateway, scoped to its authenticated operator.
 * Unlike chat streaming, this connection survives session navigation and can
 * refresh reminders; desktop alerts never include message contents.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  WebNotificationPreferences,
  WebNotificationState,
} from '../../../../container/shared/web-notifications.js';
import { requestHeaders, requestJson } from '../../api/client';
import { setChatUnreadCount } from '../../lib/browser-title';
import { disableWebPush, enableWebPush } from '../../lib/web-push';

const ENABLED_KEY = 'hybridclaw.notifications.enabled';

export function useChatNotifications(options: {
  token: string;
  enabled: boolean;
  sessionId: string;
  streamingSessionId?: string | null;
  onOpenSession: (id: string) => unknown;
  onMessage: (sessionId: string) => void;
}) {
  const deferredRefresh = useRef(new Set<string>());
  const current = useRef(options);
  current.current = options;
  const [received, setReceived] = useState<{
    token: string;
    value: WebNotificationState;
  } | null>(null);
  const state = received?.token === options.token ? received.value : null;
  const [browserEnabled, setBrowserEnabled] = useState(() => {
    try {
      return localStorage.getItem(ENABLED_KEY) === 'true';
    } catch {
      return false;
    }
  });
  const [pushEnabled, setPushEnabled] = useState(false);
  const pushEnabledRef = useRef(false);
  const browserEnabledRef = useRef(browserEnabled);
  browserEnabledRef.current = browserEnabled;
  const [busy, setBusy] = useState(false);
  const desktopNotifications = useRef(new Set<Notification>());
  const [error, setError] = useState('');
  const supported = 'Notification' in window && window.isSecureContext;

  const acknowledgeVisible = useCallback((snapshot: WebNotificationState) => {
    if (document.visibilityState !== 'visible') return;
    const ids = snapshot.notifications
      .filter((item) => item.sessionId === current.current.sessionId)
      .map((item) => item.id);
    if (ids.length)
      void requestJson('/api/push/read', {
        token: current.current.token,
        method: 'POST',
        body: { ids },
      }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!options.enabled) return;
    pushEnabledRef.current = false;
    setPushEnabled(false);
    deferredRefresh.current.clear();
    for (const notification of desktopNotifications.current)
      notification.close();
    desktopNotifications.current.clear();
    const controller = new AbortController();
    const seen = new Set<string>();
    let initialized = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const connect = async () => {
      try {
        const response = await fetch('/api/push/events', {
          headers: requestHeaders(options.token),
          signal: controller.signal,
        });
        if (!response.ok || !response.body)
          throw new Error('Notification stream unavailable');
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const chunk = await reader.read();
          if (chunk.done || controller.signal.aborted) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          let end = buffer.indexOf('\n\n');
          while (end >= 0) {
            const frame = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = frame
              .split('\n')
              .find((line) => line.startsWith('data: '));
            if (data) {
              const snapshot = JSON.parse(
                data.slice(6),
              ) as WebNotificationState;
              for (const item of snapshot.notifications) {
                if (seen.has(item.id)) continue;
                seen.add(item.id);
                deferredRefresh.current.add(item.sessionId);
                if (
                  initialized &&
                  supported &&
                  browserEnabledRef.current &&
                  !pushEnabledRef.current &&
                  snapshot.preferences[item.kind] &&
                  Notification.permission === 'granted' &&
                  document.visibilityState !== 'visible'
                ) {
                  try {
                    const notification = new Notification(item.title, {
                      body: 'Open the conversation to view it.',
                      tag: item.id,
                    });
                    desktopNotifications.current.add(notification);
                    notification.onclose = () =>
                      desktopNotifications.current.delete(notification);
                    notification.onclick = () => {
                      window.focus();
                      current.current.onOpenSession(item.sessionId);
                      notification.close();
                    };
                  } catch {
                    /* Unread badges remain available on browsers without desktop alerts. */
                  }
                }
              }
              initialized = true;
              setReceived({ token: options.token, value: snapshot });
              acknowledgeVisible(snapshot);
            }
            end = buffer.indexOf('\n\n');
          }
        }
      } catch {
        /* Reconnect without discarding unread state. */
      }
      if (!controller.signal.aborted)
        retry = setTimeout(() => void connect(), 3000);
    };
    void connect();
    return () => {
      controller.abort();
      clearTimeout(retry);
    };
  }, [options.enabled, options.token, supported, acknowledgeVisible]);

  useEffect(() => {
    if (!state) return;
    // A history refetch must not replace a streaming placeholder before the
    // final response reconciles it with the stored assistant message.
    for (const session of deferredRefresh.current) {
      if (session === options.streamingSessionId) continue;
      deferredRefresh.current.delete(session);
      current.current.onMessage(session);
    }
  }, [state, options.streamingSessionId]);

  useEffect(() => {
    if (!state || !options.sessionId) return;
    const acknowledge = () => acknowledgeVisible(state);
    acknowledge();
    document.addEventListener('visibilitychange', acknowledge);
    return () => document.removeEventListener('visibilitychange', acknowledge);
  }, [state, options.sessionId, acknowledgeVisible]);

  useEffect(() => () => setChatUnreadCount(0), []);
  useEffect(() => {
    const notifications = desktopNotifications.current;
    return () => {
      for (const notification of notifications) notification.close();
    };
  }, []);
  useEffect(() => {
    setChatUnreadCount(state?.notifications.length ?? 0);
  }, [state]);

  const operatorId = state?.operatorId;
  useEffect(() => {
    if (
      !browserEnabled ||
      !operatorId ||
      !supported ||
      Notification.permission !== 'granted'
    )
      return;
    const controller = new AbortController();
    setBusy(true);
    void enableWebPush(options.token, operatorId, controller.signal)
      .then(() => {
        if (!controller.signal.aborted) {
          pushEnabledRef.current = true;
          setPushEnabled(true);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          pushEnabledRef.current = false;
          setPushEnabled(false);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(false);
      });
    return () => {
      controller.abort();
    };
  }, [browserEnabled, operatorId, supported, options.token]);

  const toggle = async () => {
    if (!supported || !state) return;
    setBusy(true);
    setError('');
    try {
      if (browserEnabled) {
        for (const notification of desktopNotifications.current)
          notification.close();
        setBrowserEnabled(false);
        pushEnabledRef.current = false;
        setPushEnabled(false);
        localStorage.setItem(ENABLED_KEY, 'false');
        await disableWebPush(options.token);
      } else {
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') {
          setError(
            'Notifications are blocked. Allow them in browser site settings; unread badges still work.',
          );
          return;
        }
        localStorage.setItem(ENABLED_KEY, 'true');
        setBrowserEnabled(true);
      }
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : 'Could not update notifications.',
      );
    } finally {
      setBusy(false);
    }
  };

  const savePreferences = async (preferences: WebNotificationPreferences) => {
    try {
      await requestJson('/api/push/settings', {
        token: options.token,
        method: 'PUT',
        body: preferences,
      });
    } catch {
      setError('Could not save notification preferences.');
    }
  };

  const unreadSessions = new Set(
    state?.notifications.map((item) => item.sessionId),
  );
  return {
    unreadSessions,
    state,
    supported,
    browserEnabled,
    pushEnabled,
    busy,
    error,
    toggle,
    savePreferences,
  };
}
