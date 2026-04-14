import type { ChatStreamApproval, ChatStreamResult } from '../api/chat-types';
import { dispatchAuthRequired, requestHeaders } from '../api/client';

export interface ChatStreamCallbacks {
  onTextDelta: (delta: string) => void;
  onApproval: (event: ChatStreamApproval) => void;
}

export async function requestChatStream(
  url: string,
  options: {
    token: string;
    body: unknown;
    signal?: AbortSignal;
    callbacks: ChatStreamCallbacks;
  },
): Promise<ChatStreamResult> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...requestHeaders(options.token, options.body),
      Accept: 'application/x-ndjson',
    },
    body: JSON.stringify(options.body),
    signal: options.signal,
  });

  if (!response.ok) {
    const errorText = (await response.text().catch(() => '')).trim();
    let errorMessage = `${response.status} ${response.statusText}`;
    if (errorText) {
      try {
        const payload = JSON.parse(errorText) as {
          error?: string;
          text?: string;
        };
        errorMessage = payload.error || payload.text || errorText;
      } catch {
        errorMessage = errorText;
      }
    }
    if (response.status === 401) {
      dispatchAuthRequired(errorMessage);
    }
    throw new Error(errorMessage);
  }

  const { callbacks } = options;

  const parseLine = (line: string): ChatStreamResult | null => {
    const trimmedLine = String(line || '').trim();
    if (!trimmedLine) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(trimmedLine) as Record<string, unknown>;
    } catch {
      return null;
    }
    if (!payload || typeof payload !== 'object') return null;

    if (payload.type === 'text' && typeof payload.delta === 'string') {
      callbacks.onTextDelta(payload.delta as string);
      return null;
    }

    if (
      payload.type === 'approval' &&
      typeof payload.approvalId === 'string' &&
      typeof payload.prompt === 'string'
    ) {
      callbacks.onApproval(payload as unknown as ChatStreamApproval);
      return null;
    }

    if (
      payload.type === 'result' &&
      payload.result &&
      typeof payload.result === 'object'
    ) {
      return payload.result as ChatStreamResult;
    }

    if (
      typeof payload.status === 'string' &&
      Array.isArray(payload.toolsUsed)
    ) {
      return payload as unknown as ChatStreamResult;
    }

    return null;
  };

  if (!response.body) {
    const text = await response.text().catch(() => '');
    let finalResult: ChatStreamResult | null = null;
    for (const line of text.split('\n')) {
      const result = parseLine(line);
      if (result) finalResult = result;
    }
    if (!finalResult) {
      throw new Error('Chat stream ended without a result payload.');
    }
    return finalResult;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: ChatStreamResult | null = null;

  const consumeBufferedLines = (includeRemainder = false): void => {
    const lines = buffer.split('\n');
    const remainder = includeRemainder ? (lines.pop() ?? '') : null;
    buffer = includeRemainder ? '' : (lines.pop() ?? '');

    for (const line of lines) {
      const result = parseLine(line);
      if (result) finalResult = result;
    }

    if (includeRemainder && remainder?.trim()) {
      const result = parseLine(remainder);
      if (result) finalResult = result;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      consumeBufferedLines();
    }
    buffer += decoder.decode();
    consumeBufferedLines(true);
  } finally {
    reader.releaseLock();
  }

  if (!finalResult) {
    throw new Error('Chat stream ended without a result payload.');
  }
  return finalResult;
}
