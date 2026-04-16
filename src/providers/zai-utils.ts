import { ZAI_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const ZAI_MODEL_PREFIX = 'zai/';

export function readZaiApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [
      process.env.GLM_API_KEY,
      process.env.ZAI_API_KEY,
      process.env.Z_AI_API_KEY,
      ZAI_API_KEY,
    ],
    'ZAI_API_KEY',
    opts,
  );
}
