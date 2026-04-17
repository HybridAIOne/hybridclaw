export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// ChatGPT's Codex backend gates the visible model catalog by this query param.
// Values < ~0.99 only expose `gpt-5.2`; >= 1.0.0 returns the full catalog. We
// pin to a known-good release version rather than passing hybridclaw's own
// version, which falls below the gate.
export const CODEX_CLIENT_VERSION = '1.0.0';
