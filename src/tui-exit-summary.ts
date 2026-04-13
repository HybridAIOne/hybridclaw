import type { GatewayHistorySummary } from './gateway/gateway-types.js';

function hasVisibleExitSummaryActivity(
  summary: GatewayHistorySummary,
): boolean {
  return (
    summary.toolCallCount > 0 ||
    summary.inputTokenCount > 0 ||
    summary.outputTokenCount > 0 ||
    summary.costUsd > 0 ||
    summary.fileChanges.readCount > 0 ||
    summary.fileChanges.modifiedCount > 0 ||
    summary.fileChanges.createdCount > 0 ||
    summary.fileChanges.deletedCount > 0 ||
    summary.toolBreakdown.some(
      (entry) =>
        Boolean(entry?.toolName?.trim()) &&
        Number.isFinite(entry.count) &&
        entry.count > 0,
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Math.floor(ms)));
  });
}

export async function fetchTuiRemoteExitSummary(params: {
  loadRemote: () => Promise<GatewayHistorySummary | null>;
  retries?: number;
  retryDelayMs?: number;
}): Promise<{
  summary: GatewayHistorySummary | null;
  error: string | null;
}> {
  const retries =
    typeof params.retries === 'number' && Number.isFinite(params.retries)
      ? Math.max(0, Math.floor(params.retries))
      : 2;
  const retryDelayMs =
    typeof params.retryDelayMs === 'number' &&
    Number.isFinite(params.retryDelayMs)
      ? Math.max(0, Math.floor(params.retryDelayMs))
      : 150;
  let lastError: string | null = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const summary = await params.loadRemote();
      if (summary) {
        if (
          !hasVisibleExitSummaryActivity(summary) &&
          (summary.messageCount > 0 || summary.userMessageCount > 0)
        ) {
          lastError = 'Gateway history returned an empty activity summary.';
        } else {
          return {
            summary,
            error: null,
          };
        }
      }
      if (!lastError) {
        lastError = 'Gateway history returned no summary.';
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  return {
    summary: null,
    error: lastError,
  };
}
