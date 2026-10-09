/**
 * The `result` line of a streamed `/api/chat` turn, cut to what the client
 * reads. The iOS and Android apps (`client: "mobile"`) read only the reply,
 * its status and error, the stored message ids, files and email draft; each tool
 * call already reached them as a `tool` line.
 *
 * Wire-only: the caller has used the full result (artifact capture,
 * notifications, activity trace) before it sends this one. NOT show-mode
 * filtering (`show-mode.ts`), which decides what a session may see.
 */
import type { GatewayChatRequest, GatewayChatResult } from './gateway-types.js';

export function chatResultForClient(
  client: GatewayChatRequest['client'],
  result: GatewayChatResult,
): GatewayChatResult {
  if (client !== 'mobile') return result;
  // The fields both apps decode (audit 2026-10-02), plus `toolsUsed` and
  // `sessionId`, which every result carries. Tool arguments and outputs,
  // usage, prompts and routing stay on the gateway.
  return {
    status: result.status,
    result: result.result,
    error: result.error,
    errorCode: result.errorCode,
    toolsUsed: result.toolsUsed,
    sessionId: result.sessionId,
    userMessageId: result.userMessageId,
    assistantMessageId: result.assistantMessageId,
    artifacts: result.artifacts,
    ...(result.emailDraft ? { emailDraft: result.emailDraft } : {}),
  };
}
