import { XAI_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const XAI_MODEL_PREFIX = 'xai/';

export function readXaiApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.XAI_API_KEY, XAI_API_KEY],
    'XAI_API_KEY',
    opts,
  );
}
