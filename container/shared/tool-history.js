/**
 * Portable tool exchanges preserve call/result pairing across worker lifetimes.
 * Unlike audit events, these are replayable model messages; system/user roles
 * are never accepted here. Full results remain in the session transcript.
 */

// 16k chars (Codex implementation decision, 2026-09-10): keep ordinary reads
// intact within the 24k history budget; configurable retention is deferred.
export const TOOL_HISTORY_RESULT_MAX_CHARS = 16_000;

export function sessionTranscriptFilename(sessionId) {
  return `${sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session'}.jsonl`;
}

export function toolResultForHistory(message, sessionId) {
  if (
    message.role !== 'tool' ||
    typeof message.content !== 'string' ||
    message.content.length <= TOOL_HISTORY_RESULT_MAX_CHARS
  )
    return message;
  const reference = `.session-transcripts/${sessionTranscriptFilename(sessionId)}`;
  let marker = `\n\n[Tool result truncated. Full result is retained after this turn in ${reference}, tool_call_id=${JSON.stringify(message.tool_call_id)}. Use read or session_search to retrieve it.]\n\n`;
  if (marker.length >= TOOL_HISTORY_RESULT_MAX_CHARS) {
    marker =
      '\n\n[Tool result truncated. Use session_search with include_current=true to retrieve the full result after this turn.]\n\n';
  }
  const remaining = Math.max(0, TOOL_HISTORY_RESULT_MAX_CHARS - marker.length);
  const head = Math.floor(remaining * 0.8);
  return {
    ...message,
    content:
      message.content.slice(0, head).replace(/[\uD800-\uDBFF]$/, '') +
      marker +
      (remaining > head
        ? message.content
            .slice(-(remaining - head))
            .replace(/^[\uDC00-\uDFFF]/, '')
        : ''),
  };
}

export function validateToolHistory(value) {
  if (!Array.isArray(value)) throw new Error('Tool history must be an array.');
  const messages = [];
  const pending = new Set();
  for (const message of value) {
    if (
      !message ||
      typeof message !== 'object' ||
      !(message.content === null || typeof message.content === 'string')
    ) {
      throw new Error('Invalid tool history message.');
    }
    if (message.role === 'assistant') {
      if (
        pending.size ||
        !Array.isArray(message.tool_calls) ||
        !message.tool_calls.length
      ) {
        throw new Error('Tool history contains an incomplete exchange.');
      }
      for (const call of message.tool_calls) {
        if (
          !call ||
          typeof call.id !== 'string' ||
          !call.id ||
          pending.has(call.id) ||
          call.type !== 'function' ||
          typeof call.function?.name !== 'string' ||
          !call.function.name ||
          typeof call.function.arguments !== 'string'
        ) {
          throw new Error('Invalid historical tool call.');
        }
        pending.add(call.id);
      }
      const next = {
        role: 'assistant',
        content: message.content,
        tool_calls: message.tool_calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: {
            name: call.function.name,
            arguments: call.function.arguments,
          },
        })),
      };
      for (const key of ['anthropic_content', 'openai_response_items']) {
        if (message[key] !== undefined) {
          if (
            !Array.isArray(message[key]) ||
            message[key].some(
              (item) =>
                !item || typeof item !== 'object' || Array.isArray(item),
            )
          ) {
            throw new Error('Invalid provider tool history metadata.');
          }
          if (
            key === 'openai_response_items' &&
            message[key].some((item) => item.type !== 'reasoning')
          ) {
            throw new Error(
              'Only reasoning metadata may accompany historical OpenAI tool calls.',
            );
          }
          if (key === 'anthropic_content') {
            const nativeIds = new Set();
            for (const block of message[key]) {
              if (
                !['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(
                  block.type,
                )
              ) {
                throw new Error(
                  'Unexpected historical Anthropic content block.',
                );
              }
              if (block.type === 'tool_use') {
                const call = message.tool_calls.find(
                  (call) => call.id === block.id,
                );
                if (
                  !call ||
                  nativeIds.has(block.id) ||
                  call.function.name !== block.name ||
                  JSON.stringify(JSON.parse(call.function.arguments)) !==
                    JSON.stringify(block.input)
                ) {
                  throw new Error(
                    'Historical Anthropic tool metadata does not match its calls.',
                  );
                }
                nativeIds.add(block.id);
              }
            }
            if (nativeIds.size !== pending.size)
              throw new Error('Missing historical Anthropic tool metadata.');
          }
          next[key] = message[key];
        }
      }
      messages.push(next);
    } else if (
      message.role === 'tool' &&
      typeof message.content === 'string' &&
      pending.delete(message.tool_call_id)
    ) {
      messages.push({
        role: 'tool',
        content: message.content,
        tool_call_id: message.tool_call_id,
      });
    } else {
      throw new Error('Tool history contains an unexpected role or result.');
    }
  }
  if (pending.size) throw new Error('Tool history contains missing results.');
  return messages;
}
