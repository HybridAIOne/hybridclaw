/**
 * Managed MLX registration connects an installed worker to provider discovery.
 * Only setup/start actions write the endpoint and private credential reference;
 * status is read-only. Serving reconnects without selecting a default model.
 */

import {
  configureRuntimeLocalEndpoint,
  ensureRuntimeConfigFile,
  getRuntimeConfig,
  reloadRuntimeConfig,
} from '../config/runtime-config.js';
import { saveNamedRuntimeSecrets } from '../security/runtime-secrets.js';
import { MlxOperationError } from './mlx-operation-error.js';
import { mlxCredentials, mlxHome } from './mlx-runtime.js';

export function isMlxConnected(home = mlxHome()): boolean {
  try {
    const { token, baseUrl } = mlxCredentials(home);
    const endpoint = getRuntimeConfig().local.endpoints.find(
      (entry) => entry.name === 'mac-mlx',
    );
    return Boolean(
      endpoint?.type === 'mlx' &&
        endpoint.enabled &&
        endpoint.zone === 'local' &&
        endpoint.baseUrl === baseUrl &&
        endpoint.apiKey === token,
    );
  } catch {
    return false;
  }
}

export function connectMlxModel({
  home = mlxHome(),
  route,
  defaultModel,
}: {
  home?: string;
  route: string;
  defaultModel?: string;
}): void {
  const { token, baseUrl } = mlxCredentials(home);
  ensureRuntimeConfigFile();
  const config = reloadRuntimeConfig(route);
  const existing = config.local.endpoints.find(
    (entry) => entry.name === 'mac-mlx',
  );
  if (existing && existing.type !== 'mlx')
    throw new MlxOperationError('provider_conflict');
  if (isMlxConnected(home) && defaultModel === undefined) return;
  saveNamedRuntimeSecrets({ LOCAL_ENDPOINT_MAC_MLX_API_KEY: token });
  configureRuntimeLocalEndpoint(
    { name: 'mac-mlx', type: 'mlx', enabled: true, baseUrl, zone: 'local' },
    { source: 'store', id: 'LOCAL_ENDPOINT_MAC_MLX_API_KEY' },
    defaultModel,
    { route, source: 'user' },
  );
}
