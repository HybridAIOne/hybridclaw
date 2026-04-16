import { DASHSCOPE_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const DASHSCOPE_MODEL_PREFIX = 'dashscope/';

export function readDashScopeApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.DASHSCOPE_API_KEY, DASHSCOPE_API_KEY],
    'DASHSCOPE_API_KEY',
    opts,
  );
}
