import type { CdpTransport } from './cdp-transport.js';
import type { AriaNode } from './types.js';

type SnapshotTransport = Pick<CdpTransport, 'send'>;

export async function getFullAriaTree(
  connection: SnapshotTransport,
  sessionId: string,
): Promise<AriaNode[]> {
  const response = await connection.send<{ nodes?: unknown[] }>(
    'Accessibility.getFullAXTree',
    {},
    { sessionId },
  );
  return Array.isArray(response.nodes) ? (response.nodes as AriaNode[]) : [];
}
