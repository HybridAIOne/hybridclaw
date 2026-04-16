import { KILO_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const KILO_MODEL_PREFIX = 'kilo/';

export function readKiloApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [
      process.env.KILOCODE_API_KEY,
      process.env.KILO_API_KEY,
      KILO_API_KEY,
    ],
    'KILO_API_KEY',
    opts,
  );
}
