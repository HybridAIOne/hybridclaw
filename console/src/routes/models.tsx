import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { type fetchModels, saveModels } from '../api/client';
import { PageHeader, Panel } from '../components/ui';
import { useAdminQueryClient, useAdminToken } from '../hooks/use-admin';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUsd,
  joinStringList,
  parseStringList,
} from '../lib/format';
import {
  invalidateOverview,
  modelsQueryOptions,
  setModelsData,
} from '../queries';

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
  const token = useAdminToken();
  const queryClient = useAdminQueryClient();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<ModelDraft>(createDraft());

  const modelsQuery = useQuery(modelsQueryOptions(token));

  const saveMutation = useMutation({
    mutationFn: () =>
      saveModels(token, {
        defaultModel: draft.defaultModel,
        hybridaiModels: parseStringList(draft.hybridaiModels),
        codexModels: parseStringList(draft.codexModels),
      }),
    onSuccess: async (payload) => {
      setModelsData(queryClient, token, payload);
      setDraft(createDraft(payload));
      await invalidateOverview(queryClient, token);
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

  const filteredModels = (modelsQuery.data?.models || [])
    .filter((model) => {
      const haystack = [
        model.id,
        model.backend || '',
        model.family || '',
        model.parameterSize || '',
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(filter.trim().toLowerCase());
    })
    .sort(compareModelsByUsage);

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
        subtitle={`${filteredModels.length} model${filteredModels.length === 1 ? '' : 's'} visible`}
      >
        {modelsQuery.isLoading ? (
          <div className="empty-state">Loading model catalog...</div>
        ) : (
          <div className="table-shell">
            <table>
              <thead>
                <tr>
                  <th>Model</th>
                  <th>Source</th>
                  <th>Backend</th>
                  <th>Context</th>
                  <th>Monthly usage</th>
                </tr>
              </thead>
              <tbody>
                {filteredModels.map((model) => (
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
                    <td>
                      {[
                        model.configuredInHybridai ? 'hybridai' : null,
                        model.configuredInCodex ? 'codex' : null,
                        model.discovered ? 'discovered' : null,
                      ]
                        .filter(Boolean)
                        .join(', ') || 'manual'}
                    </td>
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
                {filteredModels.length === 0 ? (
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
