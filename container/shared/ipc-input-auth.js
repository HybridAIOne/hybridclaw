/**
 * Authenticity envelope for gateway→agent IPC input, shared by the gateway
 * writer (src/infra/ipc.ts) and the agent reader (container/src/ipc.ts).
 *
 * The gateway holds a per-worker secret, delivers it once in the first stdin
 * payload (never on disk, never in env), and wraps every later `input.json` in
 * `{ v, mac, body }` where `mac = HMAC-SHA256(secret, body)`. The agent verifies
 * the mac against the secret it received on stdin, so a follow-up written by
 * anything that cannot read the secret — the agent's own tools reaching the IPC
 * directory — is rejected before it becomes a turn.
 *
 * NOT the reply-file naming (ipc-output-files.js) and NOT the health probe:
 * health input carries only a liveness nonce and never drives a turn, so it is
 * not wrapped here.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const IPC_INPUT_AUTH_VERSION = 1;

/** A fresh per-worker secret. Kept in gateway memory and sent only via stdin. */
export function generateIpcAuthSecret() {
  return randomBytes(32).toString('hex');
}

function computeMac(secret, body) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

/**
 * Wrap a serialized ContainerInput body in an authenticity envelope. `body` is
 * the exact JSON string the agent will parse, so the mac covers the exact bytes
 * and no re-serialization (with its key-ordering hazards) is needed to verify.
 */
export function encodeAuthenticatedInput(secret, body) {
  return JSON.stringify({
    v: IPC_INPUT_AUTH_VERSION,
    mac: computeMac(secret, body),
    body,
  });
}

/**
 * Verify a raw `input.json` string. Returns:
 * - `{ status: 'ok', body }` — envelope authentic; `body` is the ContainerInput JSON.
 * - `{ status: 'incomplete' }` — not valid JSON yet (a torn read of an in-progress
 *   write); the caller should retry without deleting.
 * - `{ status: 'rejected', reason }` — a complete file that is not an authentic
 *   envelope; the caller should drop it. Fails closed when no secret is set.
 */
export function decodeAuthenticatedInput(secret, raw) {
  let envelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return { status: 'incomplete' };
  }
  if (
    !envelope ||
    typeof envelope !== 'object' ||
    envelope.v !== IPC_INPUT_AUTH_VERSION ||
    typeof envelope.mac !== 'string' ||
    typeof envelope.body !== 'string'
  ) {
    return { status: 'rejected', reason: 'malformed' };
  }
  if (!secret) {
    return { status: 'rejected', reason: 'no-secret' };
  }
  const expected = computeMac(secret, envelope.body);
  const actualBuf = Buffer.from(envelope.mac, 'hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  if (
    actualBuf.length !== expectedBuf.length ||
    !timingSafeEqual(actualBuf, expectedBuf)
  ) {
    return { status: 'rejected', reason: 'bad-mac' };
  }
  return { status: 'ok', body: envelope.body };
}
