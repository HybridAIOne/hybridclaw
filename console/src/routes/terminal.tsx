import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';
import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type {
  AdminTerminalClientMessage,
  AdminTerminalServerMessage,
} from '../../../src/gateway/admin-terminal-protocol.js';
import {
  adminTerminalSocketUrl,
  startAdminTerminal,
  stopAdminTerminal,
} from '../api/client';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';

type TerminalState = 'idle' | 'starting' | 'running' | 'stopping' | 'closed';

function disposeSocket(socketRef: MutableRefObject<WebSocket | null>): void {
  const socket = socketRef.current;
  socketRef.current = null;
  if (!socket) return;
  try {
    socket.close();
  } catch {
    // Ignore close races during teardown.
  }
}

function disposeTerminal(
  terminalRef: MutableRefObject<Terminal | null>,
  fitAddonRef: MutableRefObject<FitAddon | null>,
): void {
  fitAddonRef.current = null;
  const terminal = terminalRef.current;
  terminalRef.current = null;
  if (!terminal) return;
  terminal.dispose();
}

function writeTerminalFooter(
  terminalRef: MutableRefObject<Terminal | null>,
  text: string,
): void {
  const terminal = terminalRef.current;
  if (!terminal) return;
  terminal.writeln('');
  terminal.writeln(text);
}

function refitTerminal(
  terminalRef: MutableRefObject<Terminal | null>,
  fitAddonRef: MutableRefObject<FitAddon | null>,
  socketRef: MutableRefObject<WebSocket | null>,
): void {
  const fit = fitAddonRef.current;
  const terminal = terminalRef.current;
  if (!fit || !terminal) return;
  fit.fit();
  const socket = socketRef.current;
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  const message: AdminTerminalClientMessage = {
    type: 'resize',
    cols: terminal.cols,
    rows: terminal.rows,
  };
  socket.send(JSON.stringify(message));
}

export function TerminalPage() {
  const auth = useAuth();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const closeExpectedRef = useRef(false);
  const [state, setState] = useState<TerminalState>('idle');
  const [error, setError] = useState<string | null>(null);

  const disconnect = useCallback(
    async (stopOnServer: boolean): Promise<void> => {
      closeExpectedRef.current = true;
      const activeSessionId = sessionIdRef.current;
      sessionIdRef.current = null;

      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      disposeSocket(socketRef);

      if (stopOnServer && activeSessionId) {
        try {
          await stopAdminTerminal(auth.token, activeSessionId);
        } catch {
          // Best effort; websocket close already tears down the session server-side.
        }
      }
    },
    [auth.token],
  );

  const attachTerminal = (): { cols: number; rows: number } => {
    const host = containerRef.current;
    if (!host) {
      throw new Error('Terminal host is unavailable.');
    }

    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = null;
    disposeTerminal(terminalRef, fitAddonRef);
    host.innerHTML = '';

    const terminal = new Terminal({
      allowProposedApi: false,
      cols: 120,
      cursorBlink: true,
      fontFamily:
        '"SFMono-Regular", "JetBrains Mono", "Fira Code", ui-monospace, monospace',
      fontSize: 13,
      lineHeight: 1.35,
      rows: 32,
      scrollback: 5000,
      theme: {
        background: '#0f172a',
        foreground: '#e2e8f0',
        cursor: '#f8fafc',
        black: '#0f172a',
        red: '#ef4444',
        green: '#22c55e',
        yellow: '#eab308',
        blue: '#60a5fa',
        magenta: '#f472b6',
        cyan: '#22d3ee',
        white: '#e2e8f0',
        brightBlack: '#475569',
        brightRed: '#f87171',
        brightGreen: '#4ade80',
        brightYellow: '#facc15',
        brightBlue: '#93c5fd',
        brightMagenta: '#f9a8d4',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminal.focus();

    terminalRef.current = terminal;
    fitAddonRef.current = fitAddon;

    terminal.onData((data) => {
      const socket = socketRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) return;
      const message: AdminTerminalClientMessage = {
        type: 'input',
        data,
      };
      socket.send(JSON.stringify(message));
    });

    const resizeTerminal = () => {
      refitTerminal(terminalRef, fitAddonRef, socketRef);
    };

    const observer = new ResizeObserver(() => {
      resizeTerminal();
    });
    observer.observe(host);
    resizeObserverRef.current = observer;

    return { cols: terminal.cols, rows: terminal.rows };
  };

  const start = async (): Promise<void> => {
    if (state === 'starting' || state === 'running') return;

    setError(null);
    setState('starting');

    try {
      await disconnect(true);
      const dimensions = attachTerminal();
      const started = await startAdminTerminal(auth.token, dimensions);
      sessionIdRef.current = started.sessionId;

      const socket = new WebSocket(
        adminTerminalSocketUrl(auth.token, started.sessionId),
      );
      socketRef.current = socket;
      closeExpectedRef.current = false;
      const authToken = auth.token.trim();

      socket.addEventListener('open', () => {
        if (authToken) {
          const message: AdminTerminalClientMessage = {
            type: 'auth',
            token: authToken,
          };
          socket.send(JSON.stringify(message));
        }
        setState('running');
        requestAnimationFrame(() => {
          refitTerminal(terminalRef, fitAddonRef, socketRef);
        });
        void document.fonts?.ready.then(() => {
          refitTerminal(terminalRef, fitAddonRef, socketRef);
        });
        terminalRef.current?.focus();
      });

      socket.addEventListener('message', (event) => {
        let parsed: AdminTerminalServerMessage | null = null;
        try {
          parsed = JSON.parse(String(event.data)) as AdminTerminalServerMessage;
        } catch {
          parsed = null;
        }
        if (!parsed) return;
        if (parsed.type === 'output') {
          terminalRef.current?.write(parsed.data);
          return;
        }
        if (parsed.type === 'exit') {
          setState('closed');
          writeTerminalFooter(
            terminalRef,
            `\x1b[90m[terminal exited${parsed.exitCode == null ? '' : ` with code ${parsed.exitCode}`}${
              parsed.signal == null ? '' : `, signal ${parsed.signal}`
            }]\x1b[0m`,
          );
        }
      });

      socket.addEventListener('close', () => {
        socketRef.current = null;
        sessionIdRef.current = null;
        const wasExpected = closeExpectedRef.current;
        closeExpectedRef.current = false;
        if (!wasExpected) {
          setState((current) => (current === 'idle' ? current : 'closed'));
        }
      });

      socket.addEventListener('error', () => {
        setError('Terminal websocket failed.');
      });
    } catch (err) {
      await disconnect(true);
      disposeTerminal(terminalRef, fitAddonRef);
      closeExpectedRef.current = false;
      setState('idle');
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const stop = async (): Promise<void> => {
    if (state !== 'running' && state !== 'starting' && state !== 'closed') {
      return;
    }
    setState('stopping');
    await disconnect(true);
    writeTerminalFooter(terminalRef, '\x1b[90m[terminal stopped]\x1b[0m');
    setState('idle');
  };

  useEffect(() => {
    return () => {
      void disconnect(true);
      disposeTerminal(terminalRef, fitAddonRef);
    };
  }, [disconnect]);

  return (
    <div className="page-stack terminal-page">
      <PageHeader
        title="Terminal"
        actions={
          <div className="button-row">
            <span className="status-pill">
              <span
                className={
                  state === 'running'
                    ? 'status-dot live'
                    : state === 'closed'
                      ? 'status-dot status-dot-danger'
                      : 'status-dot'
                }
              />
              {state}
            </span>
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                void start();
              }}
              disabled={state === 'starting' || state === 'running'}
            >
              {state === 'starting' ? 'Starting…' : 'Start'}
            </button>
            <button
              className="ghost-button"
              type="button"
              onClick={() => {
                void stop();
              }}
              disabled={state === 'idle' || state === 'stopping'}
            >
              {state === 'stopping' ? 'Stopping…' : 'Stop'}
            </button>
          </div>
        }
      />

      <div className="terminal-panel-body">
        <div className="terminal-shell">
          <div className="terminal-host" ref={containerRef} />
          {state === 'idle' ? (
            <div className="terminal-empty-state">
              <span className="terminal-empty-copy">
                Click <strong>Start</strong> to launch the TUI process and
                attach this browser terminal to it.
              </span>
            </div>
          ) : null}
        </div>

        {error ? (
          <div className="error-banner terminal-error-banner">{error}</div>
        ) : null}
      </div>
    </div>
  );
}
