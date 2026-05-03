import { decodeA2AJsonRpcRequest } from './a2a-json-rpc.js';
import {
  type A2AOutboundAdapterOptions,
  type A2AOutboxItem,
  enqueueA2AEnvelope,
} from './a2a-outbox-persistence.js';
import type { A2AEnvelope } from './envelope.js';
import type { A2APeerDescriptor } from './peer-descriptor.js';
import type {
  TransportAdapter,
  TransportAdapterContext,
} from './transport-registry.js';

export { A2A_AGENT_CARD_CACHE_TTL_MS } from './a2a-agent-card.js';
export {
  A2A_RETRY_BASE_DELAY_MS,
  A2A_RETRY_MAX_DELAY_MS,
  type A2AOutboxProcessOptions,
} from './a2a-outbox-delivery.js';
export {
  A2A_RETRY_MAX_ATTEMPTS,
  type A2AOutboundAdapterOptions,
  type A2AOutboundStatus,
  type A2AOutboxItem,
  enqueueA2AEnvelope,
  listA2AOutboxItems,
} from './a2a-outbox-persistence.js';
export {
  A2A_OUTBOX_CONCURRENCY,
  A2A_OUTBOX_DRAIN_INTERVAL_MS,
  type A2AOutboxProcessResult,
  processA2AOutbox,
  startA2AOutboxProcessor,
  stopA2AOutboxProcessor,
} from './a2a-outbox-processor.js';

export class A2AOutboundAdapter implements TransportAdapter<A2AOutboxItem> {
  readonly transport = 'a2a' as const;

  constructor(private readonly opts: A2AOutboundAdapterOptions = {}) {}

  encode(
    envelope: A2AEnvelope,
    descriptor?: A2APeerDescriptor,
    context?: TransportAdapterContext,
  ): A2AOutboxItem {
    if (!descriptor || descriptor.transport !== 'a2a') {
      const receivedTransport = descriptor?.transport ?? 'undefined';
      throw new Error(
        `A2AOutboundAdapter requires an a2a descriptor; received "${receivedTransport}".`,
      );
    }
    return enqueueA2AEnvelope(envelope, descriptor, context, this.opts);
  }

  decode(payload: unknown): A2AEnvelope {
    return decodeA2AJsonRpcRequest(payload);
  }
}

export const a2aOutboundAdapter = new A2AOutboundAdapter();
