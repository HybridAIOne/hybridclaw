/** Trusted per-run execution limits, distinct from tool visibility/approval. */
export interface ToolCallLimits {
  /** Maximum attempted executions per exact tool name; omitted names are unlimited. */
  toolCallLimits?: Record<string, number>;
}
