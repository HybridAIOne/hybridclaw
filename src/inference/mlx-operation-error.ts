/**
 * Native lifecycle failures expose only fixed, actionable diagnostics.
 * Unlike subprocess exceptions, these messages may reach Admin and structured
 * logs. Raw library errors, credentials and process output must never be copied.
 */
const MESSAGES = {
  artifact:
    'The installed artifact is not in the supported shortlist. Run hybridclaw local setup.',
  context: 'The installed context exceeds this model’s tested limit.',
  platform: 'MLX requires Apple silicon and macOS 15 or later.',
  memory:
    'Insufficient available memory for the installed context. Close other apps or choose a smaller local model.',
  running: 'MLX is already running.',
  startup: 'MLX could not start; check the installation and available memory.',
  timeout: 'MLX model loading timed out.',
  provider_conflict:
    'The mac-mlx provider name is already used by another backend. Rename that provider before connecting the local model.',
} as const;

export class MlxOperationError extends Error {
  constructor(readonly code: keyof typeof MESSAGES) {
    super(MESSAGES[code]);
  }
}
