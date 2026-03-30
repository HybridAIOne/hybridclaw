import { getCodexAuthStatus } from '../../auth/codex-auth.js';
import { getRuntimeConfig } from '../../config/runtime-config.js';
import { resolveModelProvider } from '../../providers/factory.js';
import {
  type ProviderProbeResult,
  probeCodex,
  probeHuggingFace,
  probeHybridAI,
  probeMistral,
  probeOpenRouter,
} from '../provider-probes.js';
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom, toErrorMessage } from '../utils.js';

type ProviderKey =
  | 'hybridai'
  | 'codex'
  | 'openrouter'
  | 'mistral'
  | 'huggingface';

interface ProviderPlan {
  key: ProviderKey;
  label: string;
  active: boolean;
  configured: boolean;
  configuredModelCount: number;
  probe: (() => Promise<ProviderProbeResult>) | null;
  inactiveMessage?: string;
}

function dedupeStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const rawValue of values) {
    const value = String(rawValue || '').trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    deduped.push(value);
  }
  return deduped;
}

function formatProbeSegment(
  label: string,
  probe: ProviderProbeResult,
  configuredModelCount: number,
): string {
  if (!probe.reachable) {
    return `${label} ${probe.detail || 'unreachable'}`;
  }

  const extras: string[] = [];
  if (typeof probe.modelCount === 'number') {
    extras.push(
      label === 'HybridAI'
        ? `${probe.modelCount} bots`
        : `${probe.modelCount} models`,
    );
  } else if (configuredModelCount > 0 && label === 'Codex') {
    extras.push(`${configuredModelCount} models`);
  }
  if (probe.detail) extras.push(probe.detail);
  return `${label} ✓${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

export async function checkProviders(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const defaultProvider = resolveModelProvider(config.hybridai.defaultModel);
  const codexStatus = getCodexAuthStatus();
  const codexModels = dedupeStrings(config.codex?.models ?? []);
  const openRouterEnabled = config.openrouter?.enabled === true;
  const openRouterModels = dedupeStrings(config.openrouter?.models ?? []);
  const mistralEnabled = config.mistral?.enabled === true;
  const mistralModels = dedupeStrings(config.mistral?.models ?? []);
  const huggingFaceEnabled = config.huggingface?.enabled === true;
  const huggingFaceModels = dedupeStrings(config.huggingface?.models ?? []);
  const plans: ProviderPlan[] = [
    {
      key: 'hybridai',
      label: 'HybridAI',
      active: defaultProvider === 'hybridai',
      configured: true,
      configuredModelCount: dedupeStrings([
        config.hybridai.defaultModel,
        ...config.hybridai.models,
      ]).length,
      probe: () => probeHybridAI(),
    },
    {
      key: 'codex',
      label: 'Codex',
      active: defaultProvider === 'openai-codex',
      configured: codexStatus.authenticated || codexModels.length > 0,
      configuredModelCount: codexModels.length,
      probe: codexStatus.authenticated
        ? () =>
            probeCodex(
              codexModels[0] || config.hybridai.defaultModel || 'gpt-5',
            )
        : null,
      inactiveMessage: codexStatus.reloginRequired
        ? 'Login required'
        : 'Not authenticated',
    },
    {
      key: 'openrouter',
      label: 'OpenRouter',
      active: defaultProvider === 'openrouter',
      configured: openRouterEnabled || defaultProvider === 'openrouter',
      configuredModelCount: openRouterModels.length,
      probe:
        openRouterEnabled || defaultProvider === 'openrouter'
          ? () => probeOpenRouter()
          : null,
      inactiveMessage: 'Provider disabled',
    },
    {
      key: 'mistral',
      label: 'Mistral',
      active: defaultProvider === 'mistral',
      configured: mistralEnabled || defaultProvider === 'mistral',
      configuredModelCount: mistralModels.length,
      probe:
        mistralEnabled || defaultProvider === 'mistral'
          ? () => probeMistral()
          : null,
      inactiveMessage: 'Provider disabled',
    },
    {
      key: 'huggingface',
      label: 'Hugging Face',
      active: defaultProvider === 'huggingface',
      configured: huggingFaceEnabled || defaultProvider === 'huggingface',
      configuredModelCount: huggingFaceModels.length,
      probe:
        huggingFaceEnabled || defaultProvider === 'huggingface'
          ? () => probeHuggingFace()
          : null,
      inactiveMessage: 'Provider disabled',
    },
  ];

  const selectedPlans = plans.filter((plan) => plan.configured || plan.active);
  if (selectedPlans.length === 0) {
    return [
      makeResult(
        'providers',
        'Providers',
        'ok',
        'No remote providers configured',
      ),
    ];
  }

  const probeResults = await Promise.allSettled(
    selectedPlans.map(async (plan) => {
      if (!plan.probe) {
        return {
          key: plan.key,
          probe: {
            reachable: false,
            detail: plan.inactiveMessage || 'Not configured',
          } satisfies ProviderProbeResult,
        };
      }

      return {
        key: plan.key,
        probe: await plan.probe(),
      };
    }),
  );

  const probesByKey = new Map<ProviderKey, ProviderProbeResult>();
  const errorsByKey = new Map<ProviderKey, string>();

  probeResults.forEach((result, index) => {
    const plan = selectedPlans[index];
    if (result.status === 'fulfilled') {
      probesByKey.set(plan.key, result.value.probe);
      return;
    }
    errorsByKey.set(plan.key, toErrorMessage(result.reason));
  });

  const segments: string[] = [];
  const severities: DiagResult['severity'][] = [];

  for (const plan of selectedPlans) {
    const error = errorsByKey.get(plan.key);
    if (error) {
      segments.push(`${plan.label} ${error}`);
      severities.push(plan.active ? 'error' : 'warn');
      continue;
    }

    const probe = probesByKey.get(plan.key);
    if (!probe) {
      segments.push(`${plan.label} health unavailable`);
      severities.push(plan.active ? 'error' : 'warn');
      continue;
    }

    segments.push(
      formatProbeSegment(plan.label, probe, plan.configuredModelCount),
    );
    if (!probe.reachable) {
      severities.push(plan.active ? 'error' : 'warn');
    }
  }

  return [
    makeResult(
      'providers',
      'Providers',
      severityFrom(severities),
      segments.join('  '),
    ),
  ];
}
