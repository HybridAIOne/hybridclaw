/**
 * RFC 4122 name-based UUID (version 5, SHA-1) on `node:crypto`.
 *
 * Output is byte-identical to the `uuid` package's `v5(name, namespace)`, so
 * IDs persisted or published with it (Teams app manifests) stay stable.
 * Not a random UUID generator: use `crypto.randomUUID()` for v4.
 */
import { createHash } from 'node:crypto';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidV5(name: string, namespace: string): string {
  if (!UUID_PATTERN.test(namespace)) {
    throw new Error(`Invalid UUID namespace: ${namespace}`);
  }
  const bytes = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
