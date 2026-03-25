import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchModels, saveModels } from '../api/client';
import { useAuth } from '../auth';
import {
  Banner,
  Button,
  EmptyState,
  FormField,
  ListRow,
  PageHeader,
  Panel,
} from '../components/ui';
import {
  formatCompactNumber,
  formatRelativeTime,
  formatTokenBreakdown,
  formatUsd,
  joinStringList,
  parseStringList,
} from '../lib/format';

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
              <ListRow
                key={name}
                title={name}
                meta={
                  status?.reachable
                    ? `${status.detail || (typeof status.latencyMs === 'number' ? `${status.latencyMs}ms` : 'ready')} · ${status.modelCount ?? 0} models`
                    : status?.error || 'unreachable'
                }
                status={
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
                }
              />
            ))}
            {providerEntries.length === 0 ? (
              <EmptyState>
                No provider health checks available.
              </EmptyState>
            ) : null}
          </div>
        </Panel>

        <Panel title="Selection" accent="warm">
          {modelsQuery.isLoading ? (
            <EmptyState>Loading model catalog...</EmptyState>
          ) : (
            <div className="stack-form">
              <FormField label="Default model">
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
              </FormField>

              <FormField label="Configured HybridAI models">
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
              </FormField>

              <FormField label="Configured Codex models">
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
              </FormField>

              <div className="button-row">
                <Button
                  variant="primary"
                  disabled={saveMutation.isPending}
                  onClick={() => saveMutation.mutate()}
                >
                  {saveMutation.isPending ? 'Saving...' : 'Save selection'}
                </Button>
              </div>

              {saveMutation.isSuccess ? (
                <Banner variant="success">
                  Default model is now {saveMutation.data.defaultModel}.
                </Banner>
              ) : null}
              {saveMutation.isError ? (
                <Banner variant="error">
                  {(saveMutation.error as Error).message}
                </Banner>
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
          <EmptyState>Loading model catalog...</EmptyState>
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
                      <EmptyState>
                        No models match this filter.
                      </EmptyState>
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
                <ListRow
                  key={`${model.id}-daily`}
                  title={model.id}
                  meta={`${formatTokenBreakdown({
                    inputTokens: model.usageDaily.totalInputTokens ?? 0,
                    outputTokens: model.usageDaily.totalOutputTokens ?? 0,
                  })} · ${model.usageDaily.callCount} calls today`}
                  status={formatUsd(model.usageDaily.totalCostUsd ?? 0)}
                />
              ))}
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
