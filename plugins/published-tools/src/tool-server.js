/**
 * Published tools as MCP methods — each admin-defined tool is one agent turn
 * scoped by that tool's instructions and tool allowlist.
 *
 * The caller's `question` is only ever the user message; the tool's
 * `instructions` are the only text that reaches the system prompt. A turn
 * that stops at a human approval retires its conversation (see
 * `conversation-store.js`), because approvals are never taken from MCP.
 * Runs live in memory: a gateway restart loses them and `get_result` says so.
 */
import { randomBytes } from 'node:crypto';
import { GET_RESULT_TOOL_NAME } from './config.js';
import { RPC, RpcError, SUPPORTED_VERSIONS } from './protocol.js';

const MAX_QUESTION_CHARS = 20_000;
const MAX_ANSWER_CHARS = 100_000;
// 1h (engineering choice, 2026-09-29): a host polls within minutes; finished
// runs are kept long enough to survive a slow client without piling up.
const RUN_TTL_MS = 60 * 60 * 1000;
const LIST_TTL_MS = 60_000;

const RESULT_SCHEMA = {
  type: 'object',
  properties: {
    status: {
      type: 'string',
      enum: ['completed', 'running', 'approval_required', 'failed'],
    },
    answer: { type: 'string' },
    conversation_id: { type: 'string' },
    run_id: { type: 'string' },
  },
  required: ['status'],
};

function toolDefinition(tool) {
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description,
    inputSchema: {
      type: 'object',
      properties: {
        question: {
          type: 'string',
          description: 'The request, in the words of the user.',
        },
        conversation_id: {
          type: 'string',
          description:
            'Returned by an earlier call of this tool. Pass it to ask a follow-up in the same conversation; omit it to start a new one.',
        },
      },
      required: ['question'],
      additionalProperties: false,
    },
    outputSchema: RESULT_SCHEMA,
  };
}

const GET_RESULT_DEFINITION = {
  name: GET_RESULT_TOOL_NAME,
  title: 'Get HybridClaw result',
  description:
    'Fetch the answer of a HybridClaw tool call that returned status "running". Waits briefly, then returns the answer or "running" again.',
  inputSchema: {
    type: 'object',
    properties: {
      run_id: { type: 'string', description: 'The run_id that was returned.' },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  outputSchema: RESULT_SCHEMA,
};

function toolResult(structured, text, isError = false) {
  return {
    content: [{ type: 'text', text }],
    structuredContent: structured,
    ...(isError ? { isError: true } : {}),
  };
}

function inputError(text) {
  return toolResult({ status: 'failed' }, text, true);
}

function sessionKey(agentId, toolName, conversationId) {
  const encode = (value) => encodeURIComponent(value);
  return [
    'agent',
    encode(agentId),
    'channel',
    'mcp',
    'chat',
    'dm',
    'peer',
    encode(`${toolName}.${conversationId}`),
  ].join(':');
}

function describeApproval(pendingApproval) {
  const intent = String(pendingApproval.intent || '').trim();
  return intent ? ` (${intent})` : '';
}

/**
 * @param {{
 *   api: import('hybridclaw/plugin-sdk').HybridClawPluginApi,
 *   config: import('./config.js').PublishedToolsConfig,
 *   store: import('./conversation-store.js').ConversationStore,
 *   now?: () => number,
 * }} options
 */
export function createToolServer({ api, config, store, now = Date.now }) {
  const toolsByName = new Map(config.tools.map((tool) => [tool.name, tool]));
  const definitions = [
    ...config.tools.map(toolDefinition),
    ...(config.tools.length > 0 ? [GET_RESULT_DEFINITION] : []),
  ];
  /** @type {Map<string, { id: string, conversationId: string, promise: Promise<void>, outcome: Record<string, unknown> | null, finishedAt?: number }>} */
  const runs = new Map();
  /** conversationId -> runId while a turn is in flight */
  const busy = new Map();

  function pruneRuns() {
    const cutoff = now() - RUN_TTL_MS;
    for (const [id, run] of runs) {
      if (run.finishedAt !== undefined && run.finishedAt < cutoff) {
        runs.delete(id);
      }
    }
  }

  function settle(run, tool, result) {
    const conversationId = run.conversationId;
    if (result.pendingApproval) {
      store.retire(conversationId);
      api.logger.info(
        { tool: tool.name, runId: run.id },
        'Published tool turn stopped at an approval; conversation retired',
      );
      return toolResult(
        { status: 'approval_required' },
        `HybridClaw needs human approval for an action${describeApproval(result.pendingApproval)}. Approvals cannot be granted through this tool, so the action did not run and this conversation is closed. Ask the user to do this in HybridClaw directly, or ask again without that action.`,
        true,
      );
    }
    if (result.status !== 'success') {
      return toolResult(
        { status: 'failed', conversation_id: conversationId },
        `HybridClaw could not complete the request: ${String(result.error || 'unknown error').slice(0, 500)}`,
        true,
      );
    }
    const answer = String(result.result ?? '').slice(0, MAX_ANSWER_CHARS);
    return toolResult(
      { status: 'completed', answer, conversation_id: conversationId },
      `${answer}\n\n(conversation_id: ${conversationId})`,
    );
  }

  function startRun(tool, conversationId, question) {
    const run = {
      id: `r_${randomBytes(16).toString('base64url')}`,
      conversationId,
      outcome: null,
    };
    busy.set(conversationId, run.id);
    run.promise = api
      .dispatchInboundMessage({
        sessionId: sessionKey(tool.agentId, tool.name, conversationId),
        guildId: null,
        channelId: 'mcp',
        userId: 'mcp-client',
        username: 'MCP client',
        content: question,
        agentId: tool.agentId,
        ...(tool.allowedTools ? { allowedTools: tool.allowedTools } : {}),
        ...(tool.instructions ? { instructions: tool.instructions } : {}),
      })
      .then((result) => settle(run, tool, result))
      .catch((error) => {
        api.logger.warn(
          { tool: tool.name, runId: run.id, err: error },
          'Published tool turn failed',
        );
        return toolResult(
          { status: 'failed' },
          'HybridClaw could not complete the request.',
          true,
        );
      })
      .then((outcome) => {
        run.outcome = outcome;
        run.finishedAt = now();
        busy.delete(conversationId);
      });
    runs.set(run.id, run);
    return run;
  }

  async function awaitRun(run) {
    if (!run.outcome && config.syncWaitMs > 0) {
      let timer;
      await Promise.race([
        run.promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, config.syncWaitMs);
          timer.unref?.();
        }),
      ]);
      clearTimeout(timer);
    }
    return (
      run.outcome ??
      toolResult(
        {
          status: 'running',
          run_id: run.id,
          conversation_id: run.conversationId,
        },
        `HybridClaw is still working on this. Call ${GET_RESULT_TOOL_NAME} with run_id "${run.id}" to get the answer.`,
      )
    );
  }

  function resolveConversation(tool, conversationId) {
    if (conversationId === undefined) {
      return { id: store.create(tool.name) };
    }
    const record = store.get(conversationId);
    if (!record || record.tool !== tool.name) {
      return {
        error: `Unknown conversation_id for ${tool.name}. Omit conversation_id to start a new conversation.`,
      };
    }
    if (record.retiredAt) {
      return {
        error:
          'This conversation was closed because it needed human approval. Omit conversation_id to start a new conversation.',
      };
    }
    const runningId = busy.get(conversationId);
    if (runningId) {
      return {
        error: `The previous request in this conversation is still running. Call ${GET_RESULT_TOOL_NAME} with run_id "${runningId}" first.`,
      };
    }
    store.touch(conversationId);
    return { id: conversationId };
  }

  async function callPublishedTool(tool, args) {
    const question = typeof args.question === 'string' ? args.question : '';
    if (!question.trim() || question.length > MAX_QUESTION_CHARS) {
      return inputError(
        `question must be a non-empty string of at most ${MAX_QUESTION_CHARS} characters.`,
      );
    }
    if (
      args.conversation_id !== undefined &&
      typeof args.conversation_id !== 'string'
    ) {
      return inputError('conversation_id must be a string.');
    }
    const conversation = resolveConversation(tool, args.conversation_id);
    if (conversation.error) return inputError(conversation.error);
    pruneRuns();
    return awaitRun(startRun(tool, conversation.id, question));
  }

  async function getResult(args) {
    const run = typeof args.run_id === 'string' ? runs.get(args.run_id) : null;
    if (!run) {
      return inputError(
        'Unknown or expired run_id. Call the original tool again.',
      );
    }
    return awaitRun(run);
  }

  return {
    'server/discover': async () => ({
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: { listChanged: false } },
      ...(config.instructions ? { instructions: config.instructions } : {}),
      ttlMs: LIST_TTL_MS,
      cacheScope: 'private',
    }),
    'tools/list': async (params) => {
      if (params?.cursor !== undefined) {
        throw new RpcError(400, RPC.INVALID_PARAMS, 'Unknown cursor.');
      }
      return { tools: definitions, ttlMs: LIST_TTL_MS, cacheScope: 'private' };
    },
    'tools/call': async (params) => {
      const args =
        params.arguments && typeof params.arguments === 'object'
          ? params.arguments
          : {};
      if (params.name === GET_RESULT_TOOL_NAME && definitions.length > 0) {
        return getResult(args);
      }
      const tool = toolsByName.get(params.name);
      if (!tool) {
        throw new RpcError(
          400,
          RPC.INVALID_PARAMS,
          `Unknown tool: ${params.name}`,
        );
      }
      return callPublishedTool(tool, args);
    },
  };
}
