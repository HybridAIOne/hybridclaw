import {
  getAnthropicAuthStatus,
  isAnthropicAuthReadyForMethod,
} from '../../auth/anthropic-auth.js';
import { getCodexAuthStatus } from '../../auth/codex-auth.js';
import { getRuntimeConfig } from '../../config/runtime-config.js';
import {
  fromGatewayModelProviderKey,
  type GatewayModelProviderKey,
} from '../../gateway/model-provider-keys.js';
import { resolveModelProvider } from '../../providers/factory.js';
import { PROVIDER_META } from '../../providers/provider-meta.js';
import { dedupeStrings } from '../../utils/normalized-strings.js';
import {
  type ProviderProbeResult,
  probeAnthropic,
  probeCodex,
  probeHuggingFace,
  probeHybridAI,
  probeMistral,
  probeOpenAI,
  probeOpenRouter,
} from '../provider-probes.js';
import type { DiagResult } from '../types.js';
import { makeResult, severityFrom, toErrorMessage } from '../utils.js';

interface ProviderPlan {
  key: GatewayModelProviderKey;
  active: boolean;
  configured: boolean;
  configuredModelCount: number;
  probe: (() => Promise<ProviderProbeResult>) | null;
  inactiveMessage?: string;
}

async function readDiscoveredModelNamesSafely(): Promise<{
  hybridai: string[];
  codex: string[];
  openrouter: string[];
  mistral: string[];
  huggingface: string[];
}> {
  const [
    hybridaiDiscovery,
    codexDiscovery,
    openrouterDiscovery,
    mistralDiscovery,
    huggingFaceDiscovery,
  ] = await Promise.allSettled([
    import('../../providers/hybridai-discovery.js'),
    import('../../providers/codex-discovery.js'),
    import('../../providers/openrouter-discovery.js'),
    import('../../providers/mistral-discovery.js'),
    import('../../providers/huggingface-discovery.js'),
  ]);

  return {
    hybridai:
      hybridaiDiscovery.status === 'fulfilled'
        ? hybridaiDiscovery.value.getDiscoveredHybridAIModelNames()
        : [],
    codex:
      codexDiscovery.status === 'fulfilled'
        ? codexDiscovery.value.getDiscoveredCodexModelNames()
        : [],
    openrouter:
      openrouterDiscovery.status === 'fulfilled'
        ? openrouterDiscovery.value.getDiscoveredOpenRouterModelNames()
        : [],
    mistral:
      mistralDiscovery.status === 'fulfilled'
        ? mistralDiscovery.value.getDiscoveredMistralModelNames()
        : [],
    huggingface:
      huggingFaceDiscovery.status === 'fulfilled'
        ? huggingFaceDiscovery.value.getDiscoveredHuggingFaceModelNames()
        : [],
  };
}

function providerLabel(key: GatewayModelProviderKey): string {
  return PROVIDER_META[fromGatewayModelProviderKey(key)].label;
}

function formatProbeSegment(
  plan: ProviderPlan,
  probe: ProviderProbeResult,
): string {
  const label = providerLabel(plan.key);
  if (!probe.reachable) {
    return `${label} ${probe.detail || 'unreachable'}`;
  }

  const extras: string[] = [];
  if (typeof probe.modelCount === 'number') {
    extras.push(
      plan.key === 'hybridai'
        ? `${probe.modelCount} bots`
        : `${probe.modelCount} models`,
    );
  } else if (plan.configuredModelCount > 0 && plan.key === 'codex') {
    extras.push(`${plan.configuredModelCount} models`);
  }
  if (probe.detail) extras.push(probe.detail);
  return `${label} ✓${extras.length > 0 ? ` (${extras.join(', ')})` : ''}`;
}

export async function checkProviders(): Promise<DiagResult[]> {
  const config = getRuntimeConfig();
  const defaultProvider = resolveModelProvider(config.hybridai.defaultModel);
  const anthropicStatus = getAnthropicAuthStatus();
  const codexStatus = getCodexAuthStatus();
  const anthropicConfiguredMethod = config.anthropic?.method ?? 'api-key';
  const anthropicMethodReady = isAnthropicAuthReadyForMethod(
    anthropicStatus,
    anthropicConfiguredMethod,
  );
  const discoveredModels = await readDiscoveredModelNamesSafely();
  const anthropicEnabled = config.anthropic?.enabled === true;
  const openAIEnabled = config.openai?.enabled === true;
  const openRouterEnabled = config.openrouter?.enabled === true;
  const hybridaiModels = dedupeStrings([
    ...discoveredModels.hybridai,
    defaultProvider === 'hybridai' ? config.hybridai.defaultModel : '',
  ]);
  const codexModels = dedupeStrings([
    ...discoveredModels.codex,
    defaultProvider === 'openai-codex' ? config.hybridai.defaultModel : '',
  ]);
  const openAIModels = dedupeStrings([
    ...(config.openai?.models ?? []),
    defaultProvider === 'openai' ? config.hybridai.defaultModel : '',
  ]);
  const anthropicModels = dedupeStrings([
    ...(config.anthropic?.models ?? []),
    defaultProvider === 'anthropic' ? config.hybridai.defaultModel : '',
  ]);
  const openRouterModels = dedupeStrings(discoveredModels.openrouter);
  const mistralEnabled = config.mistral?.enabled === true;
  const mistralModels = dedupeStrings(discoveredModels.mistral);
  const huggingFaceEnabled = config.huggingface?.enabled === true;
  const huggingFaceModels = dedupeStrings(discoveredModels.huggingface);
  const plans: ProviderPlan[] = [
    {
      key: 'hybridai',
      active: defaultProvider === 'hybridai',
      configured: true,
      configuredModelCount: hybridaiModels.length,
      probe: () => probeHybridAI(),
    },
    {
      key: 'codex',
      active: defaultProvider === 'openai-codex',
      configured:
        codexStatus.authenticated || defaultProvider === 'openai-codex',
      configuredModelCount: codexModels.length,
      probe: codexStatus.authenticated ? () => probeCodex() : null,
      inactiveMessage: codexStatus.reloginRequired
        ? 'Login required'
        : 'Not authenticated',
    },
    {
      key: 'openai',
      active: defaultProvider === 'openai',
      configured: openAIEnabled || defaultProvider === 'openai',
      configuredModelCount: openAIModels.length,
      probe:
        openAIEnabled || defaultProvider === 'openai'
          ? () => probeOpenAI()
          : null,
      inactiveMessage: 'Provider disabled',
    },
    {
      key: 'anthropic',
      active: defaultProvider === 'anthropic',
      configured:
        anthropicEnabled ||
        defaultProvider === 'anthropic' ||
        anthropicMethodReady,
      configuredModelCount: anthropicModels.length,
      probe:
        anthropicEnabled ||
        defaultProvider === 'anthropic' ||
        anthropicMethodReady
          ? () => probeAnthropic()
          : null,
      inactiveMessage: anthropicMethodReady
        ? 'Provider disabled'
        : anthropicConfiguredMethod === 'claude-cli'
          ? 'Claude CLI login missing'
          : 'API key missing',
    },
    {
      key: 'openrouter',
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

  const probesByKey = new Map<GatewayModelProviderKey, ProviderProbeResult>();
  const errorsByKey = new Map<GatewayModelProviderKey, string>();

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
      segments.push(`${providerLabel(plan.key)} ${error}`);
      severities.push(plan.active ? 'error' : 'warn');
      continue;
    }

    const probe = probesByKey.get(plan.key);
    if (!probe) {
      segments.push(`${providerLabel(plan.key)} health unavailable`);
      severities.push(plan.active ? 'error' : 'warn');
      continue;
    }

    segments.push(formatProbeSegment(plan, probe));
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
