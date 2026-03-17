import { getRuntimeConfig } from '../../config/runtime-config.js';
import { resolveModelProvider } from '../../providers/factory.js';
import { checkAllBackends } from '../../providers/local-health.js';
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom } from '../utils.js';

function labelForBackend(backend: 'ollama' | 'lmstudio' | 'vllm'): string {
  if (backend === 'lmstudio') return 'LM Studio';
  if (backend === 'vllm') return 'vLLM';
  return 'Ollama';
}

export async function checkLocalBackendsCategory(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const enabledBackends = Object.entries(config.local.backends)
    .filter(([, backend]) => backend.enabled)
    .map(([name]) => name as 'ollama' | 'lmstudio' | 'vllm');

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
      segments.push(`${labelForBackend(backend)} health unavailable`);
      severities.push(defaultProvider === backend ? 'error' : 'warn');
      continue;
    }

    if (status.reachable) {
      segments.push(
        `${labelForBackend(backend)} ✓${typeof status.modelCount === 'number' ? ` (${status.modelCount} models, ${status.latencyMs}ms)` : ` (${status.latencyMs}ms)`}`,
      );
      continue;
    }

    segments.push(
      `${labelForBackend(backend)} ${status.error || 'unreachable'}`,
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
