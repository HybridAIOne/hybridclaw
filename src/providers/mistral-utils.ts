import { MISTRAL_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const MISTRAL_MODEL_PREFIX = 'mistral/';

export function readMistralApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.MISTRAL_API_KEY, MISTRAL_API_KEY],
    'MISTRAL_API_KEY',
    opts,
  );
}
