import { getRuntimeConfig } from '../config/runtime-config.js';
import { readStoredRuntimeSecrets } from '../security/runtime-secrets.js';
import type {
  ProviderCredential,
  ProviderCredentials,
} from '../types/container.js';

function readConfigValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const text = readConfigValue(value);
  return text || undefined;
}

function readSecretValue(
  secrets: Record<string, string>,
  names: string[],
): string {
  for (const name of names) {
    const value = readConfigValue(secrets[name]);
    if (value) return value;
  }
  return '';
}

function optionalSecretConfig(
  secrets: Record<string, string>,
  names: string[],
): string | undefined {
  return optionalString(readSecretValue(secrets, names));
}

function providerConfig(params: {
  apiKey: string;
  baseUrl?: string;
  imageModel?: string;
  videoModel?: string;
}): ProviderCredential | undefined {
  const apiKey = readConfigValue(params.apiKey);
  if (!apiKey) return undefined;
  return {
    apiKey,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    ...(params.imageModel ? { imageModel: params.imageModel } : {}),
    ...(params.videoModel ? { videoModel: params.videoModel } : {}),
  };
}

export function resolveProviderCredentials(): ProviderCredentials {
  const secrets = readStoredRuntimeSecrets();
  const config = getRuntimeConfig();
  return {
    openai: providerConfig({
      apiKey: readSecretValue(secrets, ['OPENAI_API_KEY']),
      baseUrl: optionalSecretConfig(secrets, ['OPENAI_BASE_URL']),
      imageModel: optionalSecretConfig(secrets, ['OPENAI_IMAGE_MODEL']),
      videoModel: optionalSecretConfig(secrets, ['OPENAI_VIDEO_MODEL']),
    }),
    gemini: providerConfig({
      apiKey: readSecretValue(secrets, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
      baseUrl: optionalString(config.gemini.baseUrl),
      imageModel: optionalSecretConfig(secrets, ['GEMINI_IMAGE_MODEL']),
      videoModel: optionalSecretConfig(secrets, ['GEMINI_VIDEO_MODEL']),
    }),
    xai: providerConfig({
      apiKey: readSecretValue(secrets, ['XAI_API_KEY']),
      baseUrl: optionalString(config.xai.baseUrl),
      imageModel: optionalSecretConfig(secrets, ['XAI_IMAGE_MODEL']),
    }),
    bfl: providerConfig({
      apiKey: readSecretValue(secrets, [
        'BFL_API_KEY',
        'BLACK_FOREST_LABS_API_KEY',
      ]),
      baseUrl: optionalSecretConfig(secrets, ['BFL_BASE_URL']),
      imageModel: optionalSecretConfig(secrets, ['BFL_IMAGE_MODEL']),
    }),
  };
}
