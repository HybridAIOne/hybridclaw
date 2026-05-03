import { type A2AEnvelope, validateA2AEnvelope } from './envelope.js';
import { isRecord } from './utils.js';

export type A2AJsonRpcMethod = 'message/send' | 'tasks/send';
export type JsonRpcId = string | number | null;

export interface A2AAgentCard {
  url: string;
  capabilities?: unknown;
  skills?: unknown;
  [key: string]: unknown;
}

export interface A2AOutboundJsonRpcRequest {
  jsonrpc: '2.0';
  method: A2AJsonRpcMethod;
  params: {
    message: {
      role: 'user';
      parts: Array<{
        kind: 'text';
        text: string;
        metadata: {
          hybridclaw: {
            intent: A2AEnvelope['intent'];
          };
        };
      }>;
      messageId: string;
      contextId: string;
      metadata: {
        hybridclaw: {
          intent: A2AEnvelope['intent'];
          envelope: A2AEnvelope;
        };
      };
      taskId?: string;
    };
    metadata: {
      hybridclaw: {
        intent: A2AEnvelope['intent'];
        envelope: A2AEnvelope;
      };
    };
  };
  id?: JsonRpcId;
}

function hasTaskCapability(card: A2AAgentCard): boolean {
  const values: unknown[] = [];
  // Agent Cards in the wild expose task support as capabilities arrays,
  // object-shaped capabilities, or skill entries; accept all three shapes.
  if (Array.isArray(card.capabilities)) values.push(...card.capabilities);
  if (isRecord(card.capabilities)) {
    for (const [key, value] of Object.entries(card.capabilities)) {
      values.push(key, value);
    }
  }
  if (Array.isArray(card.skills)) values.push(...card.skills);

  return values.some((value) => {
    if (typeof value === 'string') {
      return /(^|[/:._-])tasks?(\/send)?($|[/:._-])/i.test(value);
    }
    if (!isRecord(value)) return false;
    return ['id', 'name', 'capability', 'method']
      .map((key) => value[key])
      .some(
        (entry) =>
          typeof entry === 'string' &&
          /(^|[/:._-])tasks?(\/send)?($|[/:._-])/i.test(entry),
      );
  });
}

function resolveJsonRpcMethod(
  envelope: A2AEnvelope,
  card: A2AAgentCard,
): A2AJsonRpcMethod {
  return envelope.intent === 'handoff' && hasTaskCapability(card)
    ? 'tasks/send'
    : 'message/send';
}

export function encodeA2AJsonRpcRequest(
  envelope: A2AEnvelope,
  card: A2AAgentCard,
): A2AOutboundJsonRpcRequest {
  const canonical = validateA2AEnvelope(envelope);
  const method = resolveJsonRpcMethod(canonical, card);
  const metadata = {
    hybridclaw: {
      intent: canonical.intent,
      envelope: canonical,
    },
  };
  return {
    jsonrpc: '2.0',
    method,
    params: {
      message: {
        role: 'user',
        parts: [
          {
            kind: 'text',
            text: canonical.content,
            metadata: {
              hybridclaw: {
                intent: canonical.intent,
              },
            },
          },
        ],
        messageId: canonical.id,
        contextId: canonical.thread_id,
        metadata,
        ...(canonical.parent_message_id
          ? { taskId: canonical.parent_message_id }
          : {}),
      },
      metadata,
    },
    ...(method === 'tasks/send' ? { id: canonical.id } : {}),
  };
}

export function decodeA2AJsonRpcRequest(payload: unknown): A2AEnvelope {
  const parsed =
    typeof payload === 'string' ? (JSON.parse(payload) as unknown) : payload;
  if (!isRecord(parsed) || parsed.jsonrpc !== '2.0') {
    throw new Error('A2A JSON-RPC payload must use jsonrpc "2.0".');
  }
  const params = parsed.params;
  if (!isRecord(params)) {
    throw new Error('A2A JSON-RPC payload must include params.');
  }
  const metadata = isRecord(params.metadata) ? params.metadata : {};
  const hybridclaw = isRecord(metadata.hybridclaw)
    ? metadata.hybridclaw
    : undefined;
  if (hybridclaw?.envelope) {
    return validateA2AEnvelope(hybridclaw.envelope);
  }
  const message = isRecord(params.message) ? params.message : {};
  const messageMetadata = isRecord(message.metadata) ? message.metadata : {};
  const messageHybridclaw = isRecord(messageMetadata.hybridclaw)
    ? messageMetadata.hybridclaw
    : undefined;
  if (messageHybridclaw?.envelope) {
    return validateA2AEnvelope(messageHybridclaw.envelope);
  }
  throw new Error(
    'A2A JSON-RPC payload is missing HybridClaw envelope metadata.',
  );
}
