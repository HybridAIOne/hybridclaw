export interface MemoryCitation {
  /** Stable reference tag used in the prompt, e.g. "[mem:3]" */
  ref: string;
  /** semantic_memories.id */
  memoryId: number;
  /** Truncated content preview */
  content: string;
  /** Decayed confidence at recall time */
  confidence: number;
}

export interface SemanticMemoryEntry {
  id: number;
  session_id: string;
  role: string;
  source: string;
  scope: string;
  metadata: Record<string, unknown>;
  content: string;
  confidence: number;
  embedding: number[] | null;
  source_message_id: number | null;
  created_at: string;
  accessed_at: string;
  access_count: number;
}

export interface StructuredMemoryEntry {
  agent_id: string;
  key: string;
  value: unknown;
  version: number;
  updated_at: string;
}

export interface ArchiveEntry {
  sessionId: string;
  path: string;
  archivedAt: string;
  messageCount: number;
  estimatedTokens: number;
}

export interface CompactionStage {
  kind: 'single' | 'part' | 'merge';
  index: number;
  total: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
}

export interface CompactionConfig {
  keepRecentMessages: number;
  compactRatio: number;
  baseChunkRatio: number;
  minChunkRatio: number;
  safetyMargin: number;
  maxSingleStageTokens: number;
  minSummaryTokens: number;
  maxSummaryTokens: number;
  maxSummaryChars: number;
  archiveBaseDir?: string;
}

export interface CompactionResult {
  tokensBefore: number;
  tokensAfter: number;
  messagesCompacted: number;
  messagesPreserved: number;
  archivePath: string;
  durationMs: number;
  stages: CompactionStage[];
}
