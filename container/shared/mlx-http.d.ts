/** HTTP-only inactivity timeout; callers own MLX destination and credential checks. */
export const MLX_IDLE_TIMEOUT_MS: number;
export const MLX_MAX_RESPONSE_BYTES: number;
export const MLX_MAX_RELAY_BYTES: number;
export function fetchMlxWithIdleTimeout(
  url: string,
  init: RequestInit,
): Promise<Response>;
