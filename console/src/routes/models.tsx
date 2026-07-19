import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchModels, saveModels } from '../api/client';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldLabel } from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import {
  type ProviderEntry,
  ProviderHealth,
} from '../components/provider-health';
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

type ModelEntry = Awaited<ReturnType<typeof fetchModels>>['models'][number];
type ModelWithDailyUsage = ModelEntry & {
  usageDaily: NonNullable<ModelEntry['usageDaily']>;
};

function hasDailyUsage(model: ModelEntry): model is ModelWithDailyUsage {
  return model.usageDaily !== null;
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

function buildProviderEntries(
  payload?: Awaited<ReturnType<typeof fetchModels>>,
): Array<[string, ProviderEntry]> {
  const providerNames = new Set(Object.keys(payload?.providerStatus || {}));
  const catalogModelCounts = new Map<string, number>();
  for (const model of payload?.models || []) {
    const provider = inferProviderName(model);
    if (!provider) continue;
    providerNames.add(provider);
    catalogModelCounts.set(
      provider,
      (catalogModelCounts.get(provider) ?? 0) + 1,
    );
  }

  return [...providerNames].sort(compareProviderNames).map((name) => {
    const status = payload?.providerStatus?.[name];
    return [
      name,
      status || {
        reachable: false,
        catalogOnly: true,
        modelCount: catalogModelCounts.get(name) ?? 0,
        detail: 'Visible in catalog · no live health data',
      },
    ];
  });
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

function createDraft(
  payload?: Awaited<ReturnType<typeof fetchModels>>,
): ModelDraft {
  return {
    defaultModel: payload?.defaultModel || '',
  };
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
  const [draft, setDraft] = useState<ModelDraft>(createDraft());

  const modelsQuery = useQuery({
    queryKey: ['models', auth.token],
    queryFn: () => fetchModels(auth.token),
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

  useEffect(() => {
    if (!modelsQuery.data) return;
    setDraft((current) =>
      current.defaultModel ? current : createDraft(modelsQuery.data),
    );
  }, [modelsQuery.data]);

  const filteredModels = (modelsQuery.data?.models || []).filter((model) => {
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

  const providerEntries = buildProviderEntries(modelsQuery.data);
  const modelsWithDailyUsage = (modelsQuery.data?.models || []).filter(
    hasDailyUsage,
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
        <ProviderHealth title="Provider health" entries={providerEntries} />

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
          <CardTitle>Catalog</CardTitle>
          <CardDescription>
            {`${pluralize(models.length, 'model')} visible`}
          </CardDescription>
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
                          No models match this filter.
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
