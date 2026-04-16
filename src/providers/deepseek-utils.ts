import { DEEPSEEK_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const DEEPSEEK_MODEL_PREFIX = 'deepseek/';

export function readDeepSeekApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.DEEPSEEK_API_KEY, DEEPSEEK_API_KEY],
    'DEEPSEEK_API_KEY',
    opts,
  );
}
