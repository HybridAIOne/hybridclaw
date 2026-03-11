export interface WorkerSignatureInput {
  agentId: string;
  provider: string | undefined;
  baseUrl: string;
  apiKey: string;
  requestHeaders: Record<string, string> | undefined;
}

export function computeWorkerSignature(input: WorkerSignatureInput): string {
  const normalizedHeaders = Object.entries(input.requestHeaders || {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => [key, value]);

  return JSON.stringify({
    agentId: String(input.agentId || '').trim(),
    provider: String(input.provider || '').trim(),
    baseUrl: String(input.baseUrl || '')
      .trim()
      .replace(/\/+$/g, ''),
    apiKey: String(input.apiKey || ''),
    requestHeaders: normalizedHeaders,
  });
}
