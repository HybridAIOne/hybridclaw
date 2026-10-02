/**
 * Streamed `/api/chat` turns: one turn's NDJSON lines go to every connection
 * waiting for it.
 *
 * A turn outlives its connections. A phone that loses its network or a closed
 * tab leaves the turn running, so the turn is stored and still sends its
 * "finished" alert (`notifyWebChatResult`); only `/stop` ends it early. If the
 * same caller resends the same request while the turn runs, the resend joins
 * that turn: it gets every line so far, then the rest. It does not queue a
 * second turn that would answer the message twice.
 *
 * NOT the per-session turn queue (`handleGatewayMessage` orders a session's
 * turns). This module only decides which connections see a turn's lines.
 */
import type { ServerResponse } from 'node:http';

// 15 s (owner call, 2026-10-02, mobile stream review): well under the 60 s
// idle cutoff of common proxies and the phone apps' 180 s read timeout.
const PING_AFTER_SILENCE_MS = 15_000;
const ACCEPTED_LINE = `${JSON.stringify({ type: 'accepted' })}\n`;
const PING_LINE = `${JSON.stringify({ type: 'ping' })}\n`;

interface Connection {
  write: (line: string) => void;
  end: () => void;
}

interface RunningTurn {
  lines: string[];
  connections: Set<Connection>;
}

export interface ChatStreamTurn {
  /** Writes one line to every connection, and to any resend that joins later. */
  send: (payload: object) => void;
  /** Ends every connection. A later identical request starts a new turn. */
  end: () => void;
}

const runningTurns = new Map<string, RunningTurn>();

function openConnection(
  res: ServerResponse,
  onClose: (connection: Connection) => void,
): Connection {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    // `no-transform` stops compressing proxies from holding lines back.
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // nginx buffers proxied responses unless told not to.
    'X-Accel-Buffering': 'no',
  });
  const write = (line: string): void => {
    if (res.writableEnded || res.destroyed) return;
    res.write(line);
    ping.refresh();
  };
  const ping = setTimeout(() => write(PING_LINE), PING_AFTER_SILENCE_MS);
  const connection: Connection = {
    write,
    end: () => {
      clearTimeout(ping);
      if (!res.writableEnded) res.end();
    },
  };
  res.on('close', () => {
    clearTimeout(ping);
    onClose(connection);
  });
  // The first write sends the headers with it.
  write(ACCEPTED_LINE);
  return connection;
}

function join(turn: RunningTurn, res: ServerResponse): void {
  const connection = openConnection(res, (closed) =>
    turn.connections.delete(closed),
  );
  for (const line of turn.lines) connection.write(line);
  turn.connections.add(connection);
}

/**
 * Opens `res` as a turn stream. `key` names the request: the same caller
 * sending the same body. Returns the turn for the caller to run, or `null`
 * when the request joined a turn that is already running.
 */
export function openChatStreamTurn(
  res: ServerResponse,
  key: string,
): ChatStreamTurn | null {
  const running = runningTurns.get(key);
  if (running) {
    join(running, res);
    return null;
  }
  const turn: RunningTurn = { lines: [], connections: new Set() };
  runningTurns.set(key, turn);
  join(turn, res);
  return {
    send: (payload) => {
      if (runningTurns.get(key) !== turn) return;
      const line = `${JSON.stringify(payload)}\n`;
      turn.lines.push(line);
      for (const connection of turn.connections) connection.write(line);
    },
    end: () => {
      if (runningTurns.get(key) !== turn) return;
      runningTurns.delete(key);
      for (const connection of turn.connections) connection.end();
    },
  };
}
