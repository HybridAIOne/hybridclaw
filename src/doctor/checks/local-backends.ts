import { getRuntimeConfig } from '../../config/runtime-config.js';
import { resolveModelProvider } from '../../providers/factory.js';
import { checkAllBackends } from '../../providers/local-health.js';
import {
  isLocalBackendType,
  type LocalBackendType,
} from '../../providers/provider-ids.js';
import { PROVIDER_META } from '../../providers/provider-meta.js';
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom } from '../utils.js';

export async function checkLocalBackendsCategory(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const enabledBackends = Object.entries(config.local.backends)
    .filter(([, backend]) => backend.enabled)
    .map(([name]) => name)
    .filter((name): name is LocalBackendType => isLocalBackendType(name));

  if (enabledBackends.length === 0) {
    return [
      makeResult(
        'local-backends',
        'Local backends',
        'ok',
        'No local backends enabled',
      ),
    ];
  }

  const defaultProvider = resolveModelProvider(config.hybridai.defaultModel);
  const health = await checkAllBackends();
  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];

  for (const backend of enabledBackends) {
    const status = health.get(backend);
    if (!status) {
      segments.push(`${PROVIDER_META[backend].label} health unavailable`);
      severities.push(defaultProvider === backend ? 'error' : 'warn');
      continue;
    }

    if (status.reachable) {
      segments.push(
        `${PROVIDER_META[backend].label} ✓${typeof status.modelCount === 'number' ? ` (${status.modelCount} models, ${status.latencyMs}ms)` : ` (${status.latencyMs}ms)`}`,
      );
      continue;
    }

    segments.push(
      `${PROVIDER_META[backend].label} ${status.error || 'unreachable'}`,
    );
    severities.push(defaultProvider === backend ? 'error' : 'warn');
  }

  return [
    makeResult(
      'local-backends',
      'Local backends',
      severityFrom(severities),
      segments.join('  '),
    ),
  ];
}
