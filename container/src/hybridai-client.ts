import type { ChatCompletionResponse, ChatMessage, ToolDefinition } from './types.js';

export async function callHybridAI(
  baseUrl: string,
  apiKey: string,
  model: string,
  chatbotId: string,
  enableRag: boolean,
  messages: ChatMessage[],
  tools: ToolDefinition[],
): Promise<ChatCompletionResponse> {
  const url = `${baseUrl}/v1/chat/completions`;

  const body: Record<string, unknown> = {
    model,
    chatbot_id: chatbotId,
    messages,
    tools,
    tool_choice: 'auto',
    enable_rag: enableRag,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`HybridAI API error ${response.status}: ${text}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}
