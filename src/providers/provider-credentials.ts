import {
  BFL_API_KEY,
  GEMINI_API_KEY,
  GEMINI_BASE_URL,
  OPENAI_API_KEY,
  XAI_API_KEY,
  XAI_BASE_URL,
} from '../config/config.js';
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

function optionalEnvConfig(name: string): string | undefined {
  return optionalString(process.env[name]);
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
  return {
    openai: providerConfig({
      apiKey: OPENAI_API_KEY,
      baseUrl: optionalEnvConfig('OPENAI_BASE_URL'),
      imageModel: optionalEnvConfig('OPENAI_IMAGE_MODEL'),
      videoModel: optionalEnvConfig('OPENAI_VIDEO_MODEL'),
    }),
    gemini: providerConfig({
      apiKey: GEMINI_API_KEY,
      baseUrl: optionalString(GEMINI_BASE_URL),
      imageModel: optionalEnvConfig('GEMINI_IMAGE_MODEL'),
      videoModel: optionalEnvConfig('GEMINI_VIDEO_MODEL'),
    }),
    xai: providerConfig({
      apiKey: XAI_API_KEY,
      baseUrl: optionalString(XAI_BASE_URL),
      imageModel: optionalEnvConfig('XAI_IMAGE_MODEL'),
    }),
    bfl: providerConfig({
      apiKey: BFL_API_KEY,
      baseUrl: optionalEnvConfig('BFL_BASE_URL'),
      imageModel: optionalEnvConfig('BFL_IMAGE_MODEL'),
    }),
  };
}
