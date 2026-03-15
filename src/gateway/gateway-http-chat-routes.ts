import type { IncomingMessage, ServerResponse } from 'node:http';

import { createSilentReplyStreamFilter } from '../agent/silent-reply-stream.js';
import { logger } from '../logger.js';
import type {
  ApprovalContinuation,
  PendingApproval,
  ToolProgressEvent,
} from '../types.js';
import {
  rememberPendingApprovalEvent,
  rememberPendingApprovalFromChatResult,
} from './approval-middleware.js';
import { extractGatewayChatApprovalEvent } from './chat-approval.js';
import {
  filterChatResultForSession,
  hasMessageSendToolExecution,
  normalizePendingApprovalReply,
  normalizePlaceholderToolReply,
  normalizeSilentMessageSendReply,
} from './chat-result.js';
import { readJsonBody, sendJson } from './gateway-http-common.js';
import {
  type GatewayChatRequest,
  handleGatewayMessage,
} from './gateway-service.js';
import type { GatewayChatRequestBody } from './gateway-types.js';

type ApiChatRequestBody = GatewayChatRequestBody & { stream?: boolean };

export async function handleApiChat(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = (await readJsonBody(req)) as Partial<ApiChatRequestBody>;
  const wantsStream = body.stream === true;

  const content = body.content?.trim();
  if (!content) {
    sendJson(res, 400, { error: 'Missing `content` in request body.' });
    return;
  }

  const chatRequest: GatewayChatRequest = {
    sessionId: body.sessionId || 'web:default',
    guildId: body.guildId ?? null,
    channelId: body.channelId || 'web',
    userId: body.userId || 'web-user',
    username: body.username ?? 'web',
    content,
    agentId: body.agentId,
    chatbotId: body.chatbotId,
    enableRag: body.enableRag,
    model: body.model,
  };
  logger.debug(
    {
      sessionId: chatRequest.sessionId,
      channelId: chatRequest.channelId,
      guildId: chatRequest.guildId,
      model: chatRequest.model || null,
      stream: wantsStream,
      contentLength: chatRequest.content.length,
    },
    'Received gateway API chat request',
  );

  if (wantsStream) {
    await handleApiChatStream(req, res, chatRequest);
    return;
  }

  let capturedContinuation: ApprovalContinuation | undefined;
  const result = filterChatResultForSession(
    chatRequest.sessionId,
    normalizePendingApprovalReply(
      normalizePlaceholderToolReply(
        normalizeSilentMessageSendReply(
          await handleGatewayMessage({
            ...chatRequest,
            onPendingApprovalCaptured: ({ continuation }) => {
              capturedContinuation = continuation;
            },
          }),
        ),
      ),
    ),
  );
  await rememberPendingApprovalFromChatResult({
    sessionId: chatRequest.sessionId,
    result,
    originalUserContent: chatRequest.content,
    continuation: capturedContinuation,
    userId: chatRequest.userId,
  });
  sendJson(res, result.status === 'success' ? 200 : 500, result);
}

async function handleApiChatStream(
  req: IncomingMessage,
  res: ServerResponse,
  chatRequest: GatewayChatRequest,
): Promise<void> {
  const sendEvent = (payload: object): void => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(payload)}\n`);
  };

  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  const onToolProgress = (event: ToolProgressEvent): void => {
    sendEvent({
      type: 'tool',
      toolName: event.toolName,
      phase: event.phase,
      preview: event.preview,
      durationMs: event.durationMs,
    });
  };

  const streamFilter = createSilentReplyStreamFilter();
  const onTextDelta = (delta: string): void => {
    const filteredDelta = streamFilter.push(delta);
    if (!filteredDelta) return;
    sendEvent({
      type: 'text',
      delta: filteredDelta,
    });
  };
  let streamedApprovalId: string | null = null;
  let capturedContinuation: ApprovalContinuation | undefined;
  const onApprovalProgress = (approval: PendingApproval): void => {
    streamedApprovalId = approval.approvalId;
    void rememberPendingApprovalEvent({
      sessionId: chatRequest.sessionId,
      approval,
      originalUserContent: chatRequest.content,
      userId: chatRequest.userId,
    });
    sendEvent({
      type: 'approval',
      ...approval,
    });
  };

  try {
    let result = normalizePlaceholderToolReply(
      normalizeSilentMessageSendReply(
        await handleGatewayMessage({
          ...chatRequest,
          onTextDelta,
          onToolProgress,
          onApprovalProgress,
          onPendingApprovalCaptured: ({ continuation }) => {
            capturedContinuation = continuation;
          },
        }),
      ),
    );
    result = normalizePendingApprovalReply(result);
    if (result.status === 'success') {
      const bufferedDelta = streamFilter.flush();
      if (bufferedDelta) {
        sendEvent({
          type: 'text',
          delta: bufferedDelta,
        });
      }
      if (streamFilter.isSilent() && hasMessageSendToolExecution(result)) {
        result = {
          ...result,
          result: 'Message sent.',
        };
      }
    }
    const filteredResult = filterChatResultForSession(
      chatRequest.sessionId,
      result,
    );
    const pendingApproval = extractGatewayChatApprovalEvent(filteredResult);
    if (pendingApproval) {
      await rememberPendingApprovalEvent({
        sessionId: chatRequest.sessionId,
        approval: pendingApproval,
        fallbackPrompt: String(filteredResult.result || '').trim(),
        originalUserContent: chatRequest.content,
        continuation: capturedContinuation,
        userId: chatRequest.userId,
      });
    }
    if (pendingApproval && pendingApproval.approvalId !== streamedApprovalId) {
      sendEvent(pendingApproval);
    }
    sendEvent({
      type: 'result',
      result: filteredResult,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendEvent({
      type: 'result',
      result: {
        status: 'error',
        result: null,
        toolsUsed: [],
        error: errorMessage,
      },
    });
    logger.error(
      { error, reqUrl: '/api/chat' },
      'Gateway streaming chat failed',
    );
  } finally {
    if (!res.writableEnded) {
      res.end();
    }
  }

  req.on('close', () => {
    if (!res.writableEnded) {
      res.end();
    }
  });
}
