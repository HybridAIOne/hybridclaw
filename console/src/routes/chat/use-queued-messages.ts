/**
 * Messages typed while a reply runs. Each goes to the running turn as a
 * steering note when the gateway takes it; otherwise it waits here, bound to
 * the session it was typed in, and goes out as a turn of its own once no reply
 * runs. Typed order is kept: nothing steers past a message still waiting.
 *
 * NOT the transport (`use-chat-stream.ts` steers and sends); this only decides
 * when typed input goes out.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MediaItem } from '../../api/chat-types';
import { nextMsgId } from '../../lib/chat-helpers';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  content: string;
  media: MediaItem[];
}

export function useQueuedMessages(options: {
  sessionId: string;
  isStreaming: boolean;
  steer: (sessionId: string, content: string) => Promise<boolean>;
  send: (content: string, media: MediaItem[]) => void;
  stop: () => void;
}) {
  const { sessionId, isStreaming, steer, send, stop } = options;
  const [queue, setQueue] = useState<QueuedMessage[]>([]);
  const queueRef = useRef(queue);
  const pendingRef = useRef(Promise.resolve());

  const submit = useCallback(
    (content: string, media: MediaItem[]) => {
      if (content === '/stop' && media.length === 0) {
        stop();
        return;
      }
      const message = { id: nextMsgId(), sessionId, content, media };
      pendingRef.current = pendingRef.current.then(async () => {
        const waiting = queueRef.current.some((m) => m.sessionId === sessionId);
        if (!waiting && media.length === 0 && (await steer(sessionId, content)))
          return;
        queueRef.current = [...queueRef.current, message];
        setQueue(queueRef.current);
      });
    },
    [sessionId, steer, stop],
  );

  const remove = useCallback((id: string) => {
    queueRef.current = queueRef.current.filter((m) => m.id !== id);
    setQueue(queueRef.current);
  }, []);

  useEffect(() => {
    if (isStreaming) return;
    const next = queue.find((m) => m.sessionId === sessionId);
    if (!next) return;
    remove(next.id);
    send(next.content, next.media);
  }, [isStreaming, queue, sessionId, remove, send]);

  return {
    queued: queue.filter((m) => m.sessionId === sessionId),
    submit,
    remove,
  };
}
