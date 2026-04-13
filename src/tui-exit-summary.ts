import type { GatewayHistorySummary } from './gateway/gateway-types.js';

export async function fetchTuiRemoteExitSummary(params: {
  loadRemote: () => Promise<GatewayHistorySummary | null>;
}): Promise<{
  summary: GatewayHistorySummary | null;
  error: string | null;
}> {
  try {
    const summary = await params.loadRemote();
    return {
      summary,
      error: summary ? null : 'Gateway history returned no summary.',
    };
  } catch (error) {
    return {
      summary: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
