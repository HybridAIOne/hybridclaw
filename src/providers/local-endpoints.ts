import { getRuntimeConfig } from '../config/runtime-config.js';
import type { LocalBackendType, LocalEndpointConfig } from './local-types.js';
import { isRuntimeProviderId } from './provider-ids.js';

export const LOCAL_ENDPOINT_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface LocalEndpointModelResolution {
  endpoint: LocalEndpointConfig;
  modelId: string;
}

export function validateLocalEndpointName(name: string): string {
  const trimmed = String(name || '').trim();
  if (!trimmed) {
    throw new Error('Local endpoint name cannot be empty.');
  }
  if (!LOCAL_ENDPOINT_NAME_PATTERN.test(trimmed)) {
    throw new Error(
      `Local endpoint name "${trimmed}" must contain only letters, numbers, dots, underscores, or hyphens.`,
    );
  }
  if (
    trimmed.toLowerCase() === 'local' ||
    isRuntimeProviderId(trimmed.toLowerCase())
  ) {
    throw new Error(
      `Local endpoint name "${trimmed}" conflicts with a provider prefix.`,
    );
  }
  return trimmed;
}

export function getConfiguredLocalEndpoints(): LocalEndpointConfig[] {
  return getRuntimeConfig().local.endpoints;
}

export function findLocalEndpointByName(
  name: string,
): LocalEndpointConfig | undefined {
  const trimmed = String(name || '').trim();
  if (!trimmed) return undefined;
  return getConfiguredLocalEndpoints().find(
    (endpoint) => endpoint.name === trimmed,
  );
}

export function splitLocalEndpointModel(
  model: string,
): { endpointName: string; modelId: string } | null {
  const trimmed = String(model || '').trim();
  const slashIndex = trimmed.indexOf('/');
  if (slashIndex <= 0) return null;
  const endpointName = trimmed.slice(0, slashIndex);
  const modelId = trimmed.slice(slashIndex + 1).trim();
  if (!endpointName || !modelId) return null;
  return { endpointName, modelId };
}

export function resolveLocalEndpointForModel(
  model: string,
  expectedType?: LocalBackendType,
): LocalEndpointModelResolution | null {
  const split = splitLocalEndpointModel(model);
  if (!split) return null;
  const endpoint = findLocalEndpointByName(split.endpointName);
  if (!endpoint || endpoint.enabled !== true) return null;
  if (expectedType && endpoint.type !== expectedType) return null;
  return {
    endpoint,
    modelId: split.modelId,
  };
}

export function resolveLocalBackendFromEndpointModel(
  model: string,
): LocalBackendType | undefined {
  return resolveLocalEndpointForModel(model)?.endpoint.type;
}

export function isLocalEndpointModelForBackend(
  model: string,
  backend: LocalBackendType,
): boolean {
  return Boolean(resolveLocalEndpointForModel(model, backend));
}
