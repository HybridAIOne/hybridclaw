interface HistoryMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  anthropic_content?: Array<{ type: string; [key: string]: unknown }>;
  openai_response_items?: Array<Record<string, unknown>>;
}
export const TOOL_HISTORY_RESULT_MAX_CHARS: number;
export function sessionTranscriptFilename(sessionId: string): string;
export function toolResultForHistory<
  T extends { role: string; content: unknown; tool_call_id?: string },
>(message: T, sessionId: string): T;
export function validateToolHistory(value: unknown): HistoryMessage[];
