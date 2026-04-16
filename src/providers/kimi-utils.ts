import { KIMI_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const KIMI_MODEL_PREFIX = 'kimi/';

export function readKimiApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.KIMI_API_KEY, KIMI_API_KEY],
    'KIMI_API_KEY',
    opts,
  );
}
