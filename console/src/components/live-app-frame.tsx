import { useEffect, useRef } from 'react';
import { appViewUrl, callLiveAppTool } from '../api/apps';

interface LiveAppFrameProps {
  appId: string;
  title: string;
  token: string;
  className?: string;
}

interface LiveAppBridgeMessage {
  type: 'hybridclaw:live-app-tool-call';
  appId: string;
  requestId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseBridgeMessage(value: unknown): LiveAppBridgeMessage | null {
  if (!isRecord(value)) return null;
  if (value.type !== 'hybridclaw:live-app-tool-call') return null;
  if (typeof value.appId !== 'string') return null;
  if (typeof value.requestId !== 'string') return null;
  if (typeof value.toolName !== 'string') return null;
  const rawArgs = value.arguments;
  if (rawArgs !== undefined && !isRecord(rawArgs)) return null;
  return {
    type: 'hybridclaw:live-app-tool-call',
    appId: value.appId,
    requestId: value.requestId,
    toolName: value.toolName,
    ...(rawArgs === undefined ? {} : { arguments: rawArgs }),
  };
}

export function LiveAppFrame(props: LiveAppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    let active = true;

    const postResult = (
      requestId: string,
      result: { ok: true; payload: unknown } | { ok: false; error: string },
    ) => {
      const target = iframeRef.current?.contentWindow;
      if (!target) return;
      target.postMessage(
        {
          type: 'hybridclaw:live-app-tool-result',
          appId: props.appId,
          requestId,
          ...result,
        },
        '*',
      );
    };

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== iframeRef.current?.contentWindow) return;
      const message = parseBridgeMessage(event.data);
      if (!message || message.appId !== props.appId) return;

      void callLiveAppTool(props.token, props.appId, {
        toolName: message.toolName,
        arguments: message.arguments ?? {},
      })
        .then((payload) => {
          if (!active) return;
          postResult(message.requestId, { ok: true, payload });
        })
        .catch((error: unknown) => {
          if (!active) return;
          postResult(message.requestId, {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    };

    window.addEventListener('message', handleMessage);
    return () => {
      active = false;
      window.removeEventListener('message', handleMessage);
    };
  }, [props.appId, props.token]);

  return (
    <iframe
      ref={iframeRef}
      key={props.appId}
      className={props.className}
      title={props.title}
      src={appViewUrl(props.appId, props.token)}
      sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
    />
  );
}
