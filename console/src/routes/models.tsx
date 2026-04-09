import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchModels, saveModels } from '../api/client';
import { useAuth } from '../auth';
import {
  PageHeader,
  Panel,
  SortableHeader,
  useSortableRows,
} from '../components/ui';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUsd,
  joinStringList,
  parseStringList,
} from '../lib/format';
import { compareNumber, compareText } from '../lib/sort';

interface ModelDraft {
  defaultModel: string;
  hybridaiModels: string;
  codexModels: string;
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
  if (rightTokens !== leftTokens) return rightTokens - leftTokens;

  const leftCalls = left.usageMonthly?.callCount || 0;
  const rightCalls = right.usageMonthly?.callCount || 0;
  if (rightCalls !== leftCalls) return rightCalls - leftCalls;

  return left.id.localeCompare(right.id);
}

type ModelSortKey = 'model' | 'source' | 'backend' | 'context' | 'monthlyUsage';

function formatModelSource(model: ModelEntry): string {
  return (
    [
      model.configuredInHybridai ? 'hybridai' : null,
      model.configuredInCodex ? 'codex' : null,
      model.discovered ? 'discovered' : null,
    ]
      .filter(Boolean)
      .join(', ') || 'manual'
  );
}

const MODEL_SORTERS: Record<
  ModelSortKey,
  (left: ModelEntry, right: ModelEntry) => number
> = {
  model: (left, right) => compareText(left.id, right.id),
  source: (left, right) =>
    compareText(formatModelSource(left), formatModelSource(right)) ||
    compareText(left.id, right.id),
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
    hybridaiModels: joinStringList(payload?.hybridaiModels),
    codexModels: joinStringList(payload?.codexModels),
  };
}

export function ModelsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
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
        hybridaiModels: parseStringList(draft.hybridaiModels),
        codexModels: parseStringList(draft.codexModels),
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(['models', auth.token], payload);
      setDraft(createDraft(payload));
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
  });

  useEffect(() => {
    if (!modelsQuery.data) return;
    setDraft((current) =>
      current.defaultModel || current.hybridaiModels || current.codexModels
        ? current
        : createDraft(modelsQuery.data),
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

  const providerEntries = Object.entries(
    modelsQuery.data?.providerStatus || {},
  );
  const modelsWithDailyUsage = (modelsQuery.data?.models || []).filter(
    hasDailyUsage,
  );

  return (
    <div className="page-stack">
      <PageHeader
        title="Models"
        actions={
          <input
            className="compact-search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter models"
          />
        }
      />

      <div className="two-column-grid">
        <Panel title="Provider status">
          <div className="list-stack">
            {providerEntries.map(([name, status]) => (
              <div className="list-row" key={name}>
                <div>
                  <strong>{name}</strong>
                  <small>
                    {status?.reachable
                      ? `${status.detail || (typeof status.latencyMs === 'number' ? `${status.latencyMs}ms` : 'ready')} · ${status.modelCount ?? 0} models`
                      : status?.error || 'unreachable'}
                  </small>
                </div>
                <span
                  className={
                    status?.reachable
                      ? 'list-status list-status-success'
                      : 'list-status list-status-danger'
                  }
                >
                  <span
                    className={
                      status?.reachable
                        ? 'status-dot status-dot-success'
                        : 'status-dot status-dot-danger'
                    }
                  />
                  {status?.reachable ? 'healthy' : 'down'}
                </span>
              </div>
            ))}
            {providerEntries.length === 0 ? (
              <div className="empty-state">
                No provider health checks available.
              </div>
            ) : null}
          </div>
        </Panel>

        <Panel title="Selection" accent="warm">
          {modelsQuery.isLoading ? (
            <div className="empty-state">Loading model catalog...</div>
          ) : (
            <div className="stack-form">
              <label className="field">
                <span>Default model</span>
                <select
                  value={draft.defaultModel}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      defaultModel: event.target.value,
                    }))
                  }
                >
                  <option value="">Select model</option>
                  {(modelsQuery.data?.models || []).map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.id}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Configured HybridAI models</span>
                <textarea
                  rows={4}
                  value={draft.hybridaiModels}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      hybridaiModels: event.target.value,
                    }))
                  }
                  placeholder="One or more models, comma or newline separated"
                />
              </label>

              <label className="field">
                <span>Configured Codex models</span>
                <textarea
                  rows={4}
                  value={draft.codexModels}
                  onChange={(event) =>
                    setDraft((current) => ({
                      ...current,
                      codexModels: event.target.value,
                    }))
                  }
                  placeholder="One or more models, comma or newline separated"
                />
              </label>

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

              {saveMutation.isSuccess ? (
                <p className="success-banner">
                  Default model is now {saveMutation.data.defaultModel}.
                </p>
              ) : null}
              {saveMutation.isError ? (
                <p className="error-banner">
                  {(saveMutation.error as Error).message}
                </p>
              ) : null}
            </div>
          )}
        </Panel>
      </div>

      <Panel
        title="Catalog"
        subtitle={`${models.length} model${models.length === 1 ? '' : 's'} visible`}
      >
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
                    label="Source"
                    sortKey="source"
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
                      <small>
                        {model.isReasoning ? 'reasoning' : 'standard'}
                        {model.thinkingFormat
                          ? ` · ${model.thinkingFormat}`
                          : ''}
                        {model.family ? ` · ${model.family}` : ''}
                      </small>
                    </td>
                    <td>{formatModelSource(model)}</td>
                    <td>{model.backend || 'remote'}</td>
                    <td>
                      {model.contextWindow
                        ? `${formatCompactNumber(model.contextWindow)} ctx`
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
                            {model.usageMonthly.callCount} calls
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
                    <td colSpan={5}>
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
      </Panel>

      {modelsWithDailyUsage.length > 0 ? (
        <Panel
          title="Recent daily activity"
          subtitle={`Updated ${formatRelativeTime(new Date().toISOString())}`}
        >
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
                      · {model.usageDaily.callCount} calls today
                    </small>
                  </div>
                  <span>{formatUsd(model.usageDaily.totalCostUsd ?? 0)}</span>
                </div>
              ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
