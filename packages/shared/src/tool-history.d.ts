import type { VisualAttachmentMessage } from './visual-snapshots.js';

/** Full results restore from derived files; bounded replay remains bounded. */
export interface FileBackedToolResults {
  spilledToolCallIds?: string[];
}

/** Digest binds one saved outcome; a provider call ID alone is not identity. */
export interface FileBackedToolResult {
  resultDigest?: string;
}

export interface HistoryMessage
  extends VisualAttachmentMessage,
    FileBackedToolResult {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  is_error?: boolean;
  anthropic_content?: Array<{ type: string; [key: string]: unknown }>;
  openai_response_items?: Array<Record<string, unknown>>;
}
export const TOOL_RESULTS_DIR: string;
export function sessionTranscriptFilename(sessionId: string): string;
export function toolResultFilePath(
  sessionId: string,
  toolCallId: string | undefined,
  digest: string,
): string;
export function toolResultDigest(content: string): string;
export function isToolResultDigest(value: unknown): value is string;
export function toolResultForTransport<
  T extends { role: string; content: unknown; tool_call_id?: string },
>(message: T, resultPath?: string): T;
export function validateToolHistory(value: unknown): HistoryMessage[];
