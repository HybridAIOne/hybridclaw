import { GEMINI_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const GEMINI_MODEL_PREFIX = 'gemini/';

export function readGeminiApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [
      process.env.GOOGLE_API_KEY,
      process.env.GEMINI_API_KEY,
      GEMINI_API_KEY,
    ],
    'GEMINI_API_KEY',
    opts,
  );
}
