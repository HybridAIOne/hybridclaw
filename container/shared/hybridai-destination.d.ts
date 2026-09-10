export interface HybridAIDestination {
  protocol: 'hybridai-destination-v1';
  id: string;
  zone: 'hai' | 'region' | 'cloud';
  operator: string;
  region: string;
  retention: string;
  fallback: 'deny';
  apiBaseUrl: string;
}
export function parseHybridAIDestination(
  value: unknown,
  baseUrl: string,
): HybridAIDestination | null;
export function hybridAIDestinationHeaders(
  destination: HybridAIDestination | null,
): Record<string, string>;
export function fetchHybridAIDestination(
  url: string,
  init: RequestInit,
): Promise<Response>;
