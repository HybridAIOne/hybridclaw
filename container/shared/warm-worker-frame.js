/**
 * Stdin frame a warm worker gets before its first request: the MCP servers to
 * connect while it waits, so a claimed spare does not start connecting only
 * when the user's turn arrives. Written by the gateway runners
 * (src/infra/warm-runner-utils.ts), read by the agent (container/src/stdin.ts).
 *
 * It travels only on stdin, the channel no tool can write to, and carries
 * nothing but the MCP map the first request would carry anyway. Credentials,
 * the IPC auth secret and the session still arrive with that request. NOT a
 * request: a worker that gets this frame still waits for one.
 */

export function encodeWarmWorkerFrame(mcpServers) {
  return `${JSON.stringify({ warmWorker: { mcpServers } })}\n`;
}

/** The frame's MCP map, or null when `value` is not a warm-worker frame. */
export function readWarmWorkerFrame(value) {
  const servers = value?.warmWorker?.mcpServers;
  return servers && typeof servers === 'object' && !Array.isArray(servers)
    ? servers
    : null;
}
