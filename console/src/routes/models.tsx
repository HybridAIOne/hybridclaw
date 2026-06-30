import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchBrowserModelBridge,
  fetchModels,
  saveModels,
  startBrowserModelBridge,
  stopBrowserModelBridge,
} from '../api/client';
import { useAuth } from '../auth';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { useToast } from '../components/toast';
import { PageHeader, SortableHeader, useSortableRows } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUsd,
  pluralize,
} from '../lib/format';
import { compareNumber, compareText } from '../lib/sort';

interface ModelDraft {
  defaultModel: string;
}

interface BrowserBridgeDraft {
  model: string;
  host: string;
  port: string;
  device: string;
  dtype: string;
  maxNewTokens: string;
  apiKey: string;
  setDefault: boolean;
}

type ModelEntry = Awaited<ReturnType<typeof fetchModels>>['models'][number];
type CatalogScope = 'active' | 'all';
type ModelWithDailyUsage = ModelEntry & {
  usageDaily: NonNullable<ModelEntry['usageDaily']>;
};

function hasDailyUsage(model: ModelEntry): model is ModelWithDailyUsage {
  return model.usageDaily !== null;
}

function hasUsageSummary(summary: ModelEntry['usageMonthly']): boolean {
  return (
    (summary?.totalTokens ?? 0) > 0 ||
    (summary?.callCount ?? 0) > 0 ||
    (summary?.totalToolCalls ?? 0) > 0 ||
    (summary?.totalCostUsd ?? 0) > 0
  );
}

function hasRecordedModelUsage(model: ModelEntry): boolean {
  return (
    hasUsageSummary(model.usageMonthly) || hasUsageSummary(model.usageDaily)
  );
}

function compareModelsByUsage(left: ModelEntry, right: ModelEntry): number {
  const leftTokens = left.usageMonthly?.totalTokens || 0;
  const rightTokens = right.usageMonthly?.totalTokens || 0;
  if (leftTokens !== rightTokens) return leftTokens - rightTokens;

  const leftCalls = left.usageMonthly?.callCount || 0;
  const rightCalls = right.usageMonthly?.callCount || 0;
  if (leftCalls !== rightCalls) return leftCalls - rightCalls;

  return left.id.localeCompare(right.id);
}

type ModelSortKey = 'model' | 'backend' | 'context' | 'monthlyUsage';
type ProviderStatusEntry = NonNullable<
  Awaited<ReturnType<typeof fetchModels>>['providerStatus']
>[string];
type ProviderSummary = {
  name: string;
  status: ProviderStatusEntry | null;
};

const PROVIDER_DISPLAY_ORDER = [
  'hybridai',
  'codex',
  'openrouter',
  'mistral',
  'huggingface',
  'ollama',
  'lmstudio',
  'llamacpp',
  'vllm',
  'browser',
] as const;

function inferProviderName(
  model: Pick<ModelEntry, 'id' | 'backend'>,
): string | null {
  if (model.backend) return model.backend;
  const normalized = model.id.trim().toLowerCase();
  if (normalized.startsWith('openai-codex/')) return 'codex';
  if (normalized.startsWith('openrouter/')) return 'openrouter';
  if (normalized.startsWith('mistral/')) return 'mistral';
  if (normalized.startsWith('huggingface/')) return 'huggingface';
  return null;
}

function compareProviderNames(left: string, right: string): number {
  const leftIndex = PROVIDER_DISPLAY_ORDER.indexOf(
    left as (typeof PROVIDER_DISPLAY_ORDER)[number],
  );
  const rightIndex = PROVIDER_DISPLAY_ORDER.indexOf(
    right as (typeof PROVIDER_DISPLAY_ORDER)[number],
  );
  if (leftIndex !== -1 || rightIndex !== -1) {
    if (leftIndex === -1) return 1;
    if (rightIndex === -1) return -1;
    if (leftIndex !== rightIndex) return leftIndex - rightIndex;
  }
  return left.localeCompare(right);
}

function buildProviderSummaries(
  payload?: Awaited<ReturnType<typeof fetchModels>>,
): ProviderSummary[] {
  const providerNames = new Set(Object.keys(payload?.providerStatus || {}));
  for (const model of payload?.models || []) {
    const provider = inferProviderName(model);
    if (provider) providerNames.add(provider);
  }

  return [...providerNames].sort(compareProviderNames).map((name) => ({
    name,
    status: payload?.providerStatus?.[name] || null,
  }));
}

const MODEL_SORTERS: Record<
  ModelSortKey,
  (left: ModelEntry, right: ModelEntry) => number
> = {
  model: (left, right) => compareText(left.id, right.id),
  backend: (left, right) =>
    compareText(left.backend || 'remote', right.backend || 'remote') ||
    compareText(left.id, right.id),
  context: (left, right) =>
    compareNumber(left.contextWindow, right.contextWindow) ||
    compareText(left.id, right.id),
  monthlyUsage: compareModelsByUsage,
};

const MODEL_DEFAULT_DIRECTIONS = {
  context: 'desc',
  monthlyUsage: 'desc',
} as const;

const DEFAULT_BROWSER_BRIDGE_DRAFT: BrowserBridgeDraft = {
  model: 'LiquidAI/LFM2.5-230M-ONNX',
  host: '127.0.0.1',
  port: '8789',
  device: 'webgpu',
  dtype: 'q4',
  maxNewTokens: '2048',
  apiKey: '',
  setDefault: true,
};

const BROWSER_BRIDGE_MODEL_QUANTIZATIONS: Record<string, readonly string[]> = {
  'liquidai/lfm2.5-230m-onnx': ['q4', 'q4f32', 'q8', 'fp16', 'fp32'],
};

function createDraft(
  payload?: Awaited<ReturnType<typeof fetchModels>>,
): ModelDraft {
  return {
    defaultModel: payload?.defaultModel || '',
  };
}

function normalizeBrowserBridgeModelId(model: string): string {
  const trimmed = model.trim();
  return (
    trimmed.toLowerCase().startsWith('browser/')
      ? trimmed.slice('browser/'.length)
      : trimmed
  ).toLowerCase();
}

function getBrowserBridgeQuantizations(
  model: string,
  currentDtype?: string,
): readonly string[] {
  const modelId = normalizeBrowserBridgeModelId(
    model || DEFAULT_BROWSER_BRIDGE_DRAFT.model,
  );
  const quantizations = BROWSER_BRIDGE_MODEL_QUANTIZATIONS[modelId];
  if (quantizations) return quantizations;
  const current = String(currentDtype || '').trim();
  return [current || DEFAULT_BROWSER_BRIDGE_DRAFT.dtype];
}

function resolveBrowserBridgeDtype(model: string, dtype: string): string {
  const quantizations = getBrowserBridgeQuantizations(model, dtype);
  const normalized = dtype.trim();
  return quantizations.includes(normalized)
    ? normalized
    : quantizations[0] || DEFAULT_BROWSER_BRIDGE_DRAFT.dtype;
}

function createBrowserBridgeDraft(
  payload?: Awaited<ReturnType<typeof fetchBrowserModelBridge>>,
  current?: BrowserBridgeDraft,
): BrowserBridgeDraft {
  const bridge = payload?.bridge;
  const runningBridge = bridge?.running ? bridge : null;
  const model =
    bridge?.model || current?.model || DEFAULT_BROWSER_BRIDGE_DRAFT.model;
  const draft = {
    ...DEFAULT_BROWSER_BRIDGE_DRAFT,
    ...current,
    model,
    host: bridge?.host || current?.host || DEFAULT_BROWSER_BRIDGE_DRAFT.host,
    port: String(
      bridge?.port ?? current?.port ?? DEFAULT_BROWSER_BRIDGE_DRAFT.port,
    ),
    device:
      runningBridge?.device ||
      current?.device ||
      DEFAULT_BROWSER_BRIDGE_DRAFT.device,
    dtype:
      runningBridge?.dtype ||
      current?.dtype ||
      DEFAULT_BROWSER_BRIDGE_DRAFT.dtype,
    maxNewTokens: String(
      runningBridge?.maxNewTokens ??
        current?.maxNewTokens ??
        DEFAULT_BROWSER_BRIDGE_DRAFT.maxNewTokens,
    ),
    setDefault: current?.setDefault ?? true,
  };
  return {
    ...draft,
    dtype: resolveBrowserBridgeDtype(draft.model, draft.dtype),
  };
}

function parseBridgeInteger(value: string, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function formatModelMetadata(model: ModelEntry): string {
  return [
    model.isReasoning ? 'reasoning' : '',
    model.thinkingFormat || '',
    model.family || '',
  ]
    .filter(Boolean)
    .join(' · ');
}

export function ModelsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [filter, setFilter] = useState('');
  const [catalogScope, setCatalogScope] = useState<CatalogScope>('active');
  const [draft, setDraft] = useState<ModelDraft>(createDraft());
  const [bridgeDraft, setBridgeDraft] = useState<BrowserBridgeDraft>(
    createBrowserBridgeDraft(),
  );
  const [bridgeDraftInitialized, setBridgeDraftInitialized] = useState(false);

  const modelsQuery = useQuery({
    queryKey: ['models', auth.token],
    queryFn: () => fetchModels(auth.token),
  });

  const bridgeQuery = useQuery({
    queryKey: ['browser-model-bridge', auth.token],
    queryFn: () => fetchBrowserModelBridge(auth.token),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      saveModels(auth.token, {
        defaultModel: draft.defaultModel,
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(['models', auth.token], payload);
      setDraft(createDraft(payload));
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success(`Default model is now ${payload.defaultModel}.`);
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const startBridgeMutation = useMutation({
    mutationFn: () => {
      const apiKey = bridgeDraft.apiKey.trim();
      const model =
        bridgeDraft.model.trim() || DEFAULT_BROWSER_BRIDGE_DRAFT.model;
      return startBrowserModelBridge(auth.token, {
        model,
        host: bridgeDraft.host.trim() || DEFAULT_BROWSER_BRIDGE_DRAFT.host,
        port: parseBridgeInteger(
          bridgeDraft.port,
          Number(DEFAULT_BROWSER_BRIDGE_DRAFT.port),
        ),
        device:
          bridgeDraft.device.trim() || DEFAULT_BROWSER_BRIDGE_DRAFT.device,
        dtype: resolveBrowserBridgeDtype(model, bridgeDraft.dtype),
        maxNewTokens: parseBridgeInteger(
          bridgeDraft.maxNewTokens,
          Number(DEFAULT_BROWSER_BRIDGE_DRAFT.maxNewTokens),
        ),
        setDefault: bridgeDraft.setDefault,
        ...(apiKey ? { apiKey } : {}),
      });
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(['browser-model-bridge', auth.token], payload);
      queryClient.setQueryData(['models', auth.token], payload.models);
      setDraft(createDraft(payload.models));
      setBridgeDraft((current) => createBrowserBridgeDraft(payload, current));
      setBridgeDraftInitialized(true);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      window.open(payload.bridge.pageUrl, '_blank', 'noopener,noreferrer');
      toast.success('Browser bridge started.', payload.bridge.pageUrl);
    },
    onError: (error) => {
      toast.error('Bridge start failed', getErrorMessage(error));
    },
  });

  const stopBridgeMutation = useMutation({
    mutationFn: () => stopBrowserModelBridge(auth.token),
    onSuccess: (payload) => {
      queryClient.setQueryData(['browser-model-bridge', auth.token], payload);
      queryClient.setQueryData(['models', auth.token], payload.models);
      setBridgeDraft((current) => createBrowserBridgeDraft(payload, current));
      setBridgeDraftInitialized(true);
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
      toast.success('Browser bridge stopped.');
    },
    onError: (error) => {
      toast.error('Bridge stop failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    if (!modelsQuery.data) return;
    setDraft((current) =>
      current.defaultModel ? current : createDraft(modelsQuery.data),
    );
  }, [modelsQuery.data]);

  useEffect(() => {
    if (!bridgeQuery.data || bridgeDraftInitialized) return;
    setBridgeDraft((current) =>
      createBrowserBridgeDraft(bridgeQuery.data, current),
    );
    setBridgeDraftInitialized(true);
  }, [bridgeDraftInitialized, bridgeQuery.data]);

  const allCatalogModels = modelsQuery.data?.models || [];
  const scopedCatalogModels =
    catalogScope === 'active'
      ? allCatalogModels.filter(hasRecordedModelUsage)
      : allCatalogModels;
  const filteredModels = scopedCatalogModels.filter((model) => {
    const haystack = [
      model.id,
      model.backend || '',
      model.family || '',
      model.parameterSize || '',
    ]
      .join(' ')
      .toLowerCase();
    return haystack.includes(filter.trim().toLowerCase());
  });
  const {
    sortedRows: models,
    sortState,
    toggleSort,
  } = useSortableRows<ModelEntry, ModelSortKey>(filteredModels, {
    initialSort: {
      key: 'monthlyUsage',
      direction: 'desc',
    },
    sorters: MODEL_SORTERS,
    defaultDirections: MODEL_DEFAULT_DIRECTIONS,
  });

  const providerEntries = buildProviderSummaries(modelsQuery.data);
  const modelsWithDailyUsage = (modelsQuery.data?.models || []).filter(
    hasDailyUsage,
  );
  const activeModelCount = allCatalogModels.filter(
    hasRecordedModelUsage,
  ).length;
  const bridgeStatus = bridgeQuery.data?.bridge;
  const bridgeConfiguredModel =
    bridgeStatus?.configuredModel ||
    `browser/${bridgeDraft.model.trim() || DEFAULT_BROWSER_BRIDGE_DRAFT.model}`;
  const bridgePageUrl =
    bridgeStatus?.pageUrl ||
    `http://${bridgeDraft.host || DEFAULT_BROWSER_BRIDGE_DRAFT.host}:${
      bridgeDraft.port || DEFAULT_BROWSER_BRIDGE_DRAFT.port
    }/`;
  const bridgeQuantizations = getBrowserBridgeQuantizations(
    bridgeDraft.model,
    bridgeDraft.dtype,
  );
  const bridgeDtype = resolveBrowserBridgeDtype(
    bridgeDraft.model,
    bridgeDraft.dtype,
  );

  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter models"
          />
        }
      />

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Provider status</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="list-stack">
              {providerEntries.map(({ name, status }) => (
                <div className="list-row" key={name}>
                  <div>
                    <strong>{name}</strong>
                    <small>
                      {status?.reachable
                        ? `${status.detail || (typeof status.latencyMs === 'number' ? `${status.latencyMs}ms` : 'ready')} · ${status.modelCount ?? 0} models`
                        : status
                          ? status.error || 'unreachable'
                          : 'Visible in catalog · no live health data'}
                    </small>
                  </div>
                  <span
                    className={
                      status?.reachable
                        ? 'list-status list-status-success'
                        : status
                          ? 'list-status list-status-danger'
                          : 'list-status'
                    }
                  >
                    <span
                      className={
                        status?.reachable
                          ? 'status-dot status-dot-success'
                          : status
                            ? 'status-dot status-dot-danger'
                            : 'status-dot'
                      }
                    />
                    {status?.reachable
                      ? 'healthy'
                      : status
                        ? 'down'
                        : 'catalog'}
                  </span>
                </div>
              ))}
              {providerEntries.length === 0 ? (
                <div className="empty-state">
                  No provider health checks available.
                </div>
              ) : null}
            </div>
          </CardContent>
        </Card>

        <Card variant="muted">
          <CardHeader>
            <CardTitle>Selection</CardTitle>
          </CardHeader>
          <CardContent>
            {modelsQuery.isLoading ? (
              <div className="empty-state">Loading model catalog...</div>
            ) : (
              <div className="stack-form">
                <Field>
                  <FieldLabel>Default model</FieldLabel>
                  <NativeSelect
                    value={draft.defaultModel}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        defaultModel: event.target.value,
                      }))
                    }
                  >
                    <NativeSelectOption value="">
                      Select model
                    </NativeSelectOption>
                    {(modelsQuery.data?.models || []).map((model) => (
                      <NativeSelectOption key={model.id} value={model.id}>
                        {model.id}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>

                <div className="button-row">
                  <button
                    className="primary-button"
                    type="button"
                    disabled={saveMutation.isPending}
                    onClick={() => saveMutation.mutate()}
                  >
                    {saveMutation.isPending ? 'Saving...' : 'Save selection'}
                  </button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Browser model bridge</CardTitle>
          <CardDescription>
            {bridgeStatus?.running
              ? `Serving ${bridgeConfiguredModel}`
              : 'Stopped'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {bridgeQuery.isLoading ? (
            <div className="empty-state">Loading browser bridge...</div>
          ) : (
            <div className="stack-form">
              <div className="two-column-grid">
                <Field>
                  <FieldLabel>Model</FieldLabel>
                  <Input
                    value={bridgeDraft.model}
                    onChange={(event) =>
                      setBridgeDraft((current) => {
                        const model = event.target.value;
                        return {
                          ...current,
                          model,
                          dtype: resolveBrowserBridgeDtype(
                            model,
                            current.dtype,
                          ),
                        };
                      })
                    }
                    placeholder="LiquidAI/LFM2.5-230M-ONNX"
                  />
                </Field>
                <Field>
                  <FieldLabel>Host</FieldLabel>
                  <Input
                    value={bridgeDraft.host}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        host: event.target.value,
                      }))
                    }
                    placeholder="127.0.0.1"
                  />
                </Field>
                <Field>
                  <FieldLabel>Port</FieldLabel>
                  <Input
                    inputMode="numeric"
                    value={bridgeDraft.port}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        port: event.target.value,
                      }))
                    }
                    placeholder="8789"
                  />
                </Field>
                <Field>
                  <FieldLabel>Device</FieldLabel>
                  <NativeSelect
                    value={bridgeDraft.device}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        device: event.target.value,
                      }))
                    }
                  >
                    <NativeSelectOption value="webgpu">
                      webgpu
                    </NativeSelectOption>
                    <NativeSelectOption value="wasm">wasm</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>Quantization</FieldLabel>
                  <NativeSelect
                    value={bridgeDtype}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        dtype: event.target.value,
                      }))
                    }
                  >
                    {bridgeQuantizations.map((quantization) => (
                      <NativeSelectOption
                        key={quantization}
                        value={quantization}
                      >
                        {quantization}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field>
                  <FieldLabel>Max new tokens</FieldLabel>
                  <Input
                    inputMode="numeric"
                    value={bridgeDraft.maxNewTokens}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        maxNewTokens: event.target.value,
                      }))
                    }
                    placeholder="2048"
                  />
                </Field>
                <Field>
                  <FieldLabel>API key</FieldLabel>
                  <Input
                    type="password"
                    value={bridgeDraft.apiKey}
                    onChange={(event) =>
                      setBridgeDraft((current) => ({
                        ...current,
                        apiKey: event.target.value,
                      }))
                    }
                    placeholder="optional"
                  />
                </Field>
              </div>

              <label className="inline-checkbox">
                <input
                  type="checkbox"
                  checked={bridgeDraft.setDefault}
                  onChange={(event) =>
                    setBridgeDraft((current) => ({
                      ...current,
                      setDefault: event.target.checked,
                    }))
                  }
                />
                <span>Set as default model</span>
              </label>

              <div className="info-row">
                <div>
                  <strong>
                    {bridgeStatus?.running ? 'Running' : 'Not running'}
                  </strong>
                  <small>
                    {bridgeStatus?.running
                      ? bridgeStatus.endpointUrl
                      : bridgeConfiguredModel}
                  </small>
                  {bridgeStatus?.running ? (
                    <small>Keep the opened browser tab active.</small>
                  ) : null}
                  {bridgeQuery.isError ? (
                    <small className="row-status-note-danger">
                      {getErrorMessage(bridgeQuery.error)}
                    </small>
                  ) : null}
                </div>
                <span
                  className={
                    bridgeStatus?.running
                      ? 'list-status list-status-success'
                      : 'list-status'
                  }
                >
                  <span
                    className={
                      bridgeStatus?.running
                        ? 'status-dot status-dot-success'
                        : 'status-dot'
                    }
                  />
                  {bridgeStatus?.running ? 'running' : 'stopped'}
                </span>
              </div>

              <div className="button-row">
                <button
                  className="primary-button"
                  type="button"
                  disabled={
                    startBridgeMutation.isPending || !bridgeDraft.model.trim()
                  }
                  onClick={() => startBridgeMutation.mutate()}
                >
                  {startBridgeMutation.isPending
                    ? 'Starting...'
                    : 'Start bridge'}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={
                    !bridgeStatus?.running || stopBridgeMutation.isPending
                  }
                  onClick={() => stopBridgeMutation.mutate()}
                >
                  {stopBridgeMutation.isPending ? 'Stopping...' : 'Stop'}
                </button>
                <button
                  className="ghost-button"
                  type="button"
                  disabled={!bridgeStatus?.running}
                  onClick={() =>
                    window.open(bridgePageUrl, '_blank', 'noopener,noreferrer')
                  }
                >
                  Open tab
                </button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Catalog</CardTitle>
          <CardDescription>
            {`${pluralize(models.length, 'model')} visible`}
          </CardDescription>
          <CardAction>
            <Field>
              <FieldLabel>Catalog view</FieldLabel>
              <NativeSelect
                size="sm"
                value={catalogScope}
                onChange={(event) =>
                  setCatalogScope(event.target.value as CatalogScope)
                }
              >
                <NativeSelectOption value="active">
                  {`Active (${activeModelCount})`}
                </NativeSelectOption>
                <NativeSelectOption value="all">
                  {`All (${allCatalogModels.length})`}
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </CardAction>
        </CardHeader>
        <CardContent>
          {modelsQuery.isLoading ? (
            <div className="empty-state">Loading model catalog...</div>
          ) : (
            <div className="table-shell">
              <table>
                <thead>
                  <tr>
                    <SortableHeader
                      label="Model"
                      sortKey="model"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Backend"
                      sortKey="backend"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Context"
                      sortKey="context"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                    <SortableHeader
                      label="Monthly usage"
                      sortKey="monthlyUsage"
                      sortState={sortState}
                      onToggle={toggleSort}
                    />
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model.id}>
                      <td>
                        <strong>{model.id}</strong>
                        {formatModelMetadata(model) ? (
                          <small>{formatModelMetadata(model)}</small>
                        ) : null}
                      </td>
                      <td>{model.backend || 'remote'}</td>
                      <td>
                        {model.contextWindow
                          ? formatCompactNumber(model.contextWindow)
                          : 'unknown'}
                      </td>
                      <td>
                        {model.usageMonthly ? (
                          <>
                            <strong>
                              {formatCompactNumber(
                                model.usageMonthly.totalTokens,
                              )}
                            </strong>
                            <small>
                              {formatTokenBreakdown({
                                inputTokens:
                                  model.usageMonthly.totalInputTokens ?? 0,
                                outputTokens:
                                  model.usageMonthly.totalOutputTokens ?? 0,
                              })}
                            </small>
                            <small>
                              {formatUsd(model.usageMonthly.totalCostUsd)} ·{' '}
                              {pluralize(model.usageMonthly.callCount, 'call')}
                            </small>
                          </>
                        ) : (
                          <small>No usage recorded</small>
                        )}
                      </td>
                    </tr>
                  ))}
                  {models.length === 0 ? (
                    <tr>
                      <td colSpan={4}>
                        <div className="empty-state">
                          {catalogScope === 'active'
                            ? 'No active models match this filter.'
                            : 'No models match this filter.'}
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {modelsWithDailyUsage.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Recent daily activity</CardTitle>
            <CardDescription>
              {`Updated ${formatRelativeTime(new Date().toISOString())}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="list-stack">
              {modelsWithDailyUsage
                .sort(
                  (left, right) =>
                    right.usageDaily.totalTokens - left.usageDaily.totalTokens,
                )
                .slice(0, 6)
                .map((model) => (
                  <div className="list-row" key={`${model.id}-daily`}>
                    <div>
                      <strong>{model.id}</strong>
                      <small>
                        {formatTokenBreakdown({
                          inputTokens: model.usageDaily.totalInputTokens ?? 0,
                          outputTokens: model.usageDaily.totalOutputTokens ?? 0,
                        })}{' '}
                        · {pluralize(model.usageDaily.callCount, 'call')} today
                      </small>
                    </div>
                    <span>{formatUsd(model.usageDaily.totalCostUsd ?? 0)}</span>
                  </div>
                ))}
            </div>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
