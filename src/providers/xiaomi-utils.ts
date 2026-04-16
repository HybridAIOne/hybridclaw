import { XIAOMI_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const XIAOMI_MODEL_PREFIX = 'xiaomi/';

export function readXiaomiApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.XIAOMI_API_KEY, XIAOMI_API_KEY],
    'XIAOMI_API_KEY',
    opts,
  );
}
