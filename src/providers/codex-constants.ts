export const CODEX_DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api/codex';

// ChatGPT's Codex backend gates the visible model catalog by this query param.
// Below ~1.0 the API returns a single entry with raw id `gpt-5.2` (which we
// normalize to `openai-codex/gpt-5.2`); at `1.0.0` and above it returns the
// full catalog. We pin to a known-good release version rather than passing
// hybridclaw's own package version, which falls below the gate.
export const CODEX_CLIENT_VERSION = '1.0.0';
