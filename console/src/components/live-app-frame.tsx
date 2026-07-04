import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import { appViewUrl, callLiveAppTool } from '../api/apps';

interface LiveAppFrameProps {
  appId: string;
  title: string;
  token: string;
  className?: string;
  refreshNonce?: number;
}

interface LiveAppBridgeMessage {
  type: 'hybridclaw:live-app-tool-call';
  appId: string;
  requestId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface LiveAppFrameHandle {
  refreshData: () => boolean;
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

export const LiveAppFrame = forwardRef<LiveAppFrameHandle, LiveAppFrameProps>(
  function LiveAppFrame(props, ref) {
    const iframeRef = useRef<HTMLIFrameElement | null>(null);
    const loadedRef = useRef(false);
    const appIdRef = useRef(props.appId);
    if (appIdRef.current !== props.appId) {
      appIdRef.current = props.appId;
      loadedRef.current = false;
    }

    const postRefreshRequest = useCallback((): boolean => {
      const target = iframeRef.current?.contentWindow;
      if (!target || !loadedRef.current) return false;
      target.postMessage(
        {
          type: 'hybridclaw:live-app-refresh',
          appId: props.appId,
        },
        '*',
      );
      return true;
    }, [props.appId]);

    useImperativeHandle(
      ref,
      () => ({
        refreshData: postRefreshRequest,
      }),
      [postRefreshRequest],
    );

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

    useEffect(() => {
      if (!props.refreshNonce || !loadedRef.current) return;
      postRefreshRequest();
    }, [postRefreshRequest, props.refreshNonce]);

    return (
      <iframe
        ref={iframeRef}
        key={props.appId}
        className={props.className}
        title={props.title}
        src={appViewUrl(props.appId, props.token)}
        sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox"
        onLoad={() => {
          loadedRef.current = true;
          if (props.refreshNonce) postRefreshRequest();
        }}
      />
    );
  },
);
