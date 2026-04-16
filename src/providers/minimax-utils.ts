import { MINIMAX_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const MINIMAX_MODEL_PREFIX = 'minimax/';

export function readMiniMaxApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [process.env.MINIMAX_API_KEY, MINIMAX_API_KEY],
    'MINIMAX_API_KEY',
    opts,
  );
}
