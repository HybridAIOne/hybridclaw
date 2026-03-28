import { HUGGINGFACE_API_KEY } from '../config/config.js';
import { readProviderApiKey } from './provider-api-key-utils.js';

export const HUGGINGFACE_MODEL_PREFIX = 'huggingface/';

export function readHuggingFaceApiKey(opts?: { required?: boolean }): string {
  return readProviderApiKey(
    () => [
      process.env.HF_TOKEN,
      process.env.HUGGINGFACE_API_KEY,
      HUGGINGFACE_API_KEY,
    ],
    'HF_TOKEN',
    opts,
  );
}
