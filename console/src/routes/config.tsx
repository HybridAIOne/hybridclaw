import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { useToast } from '../components/toast';
import { BooleanField, PageHeader, Panel } from '../components/ui';

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

export function ConfigPage() {
  const auth = useAuth();
  const toast = useToast();
  const [rawMode, setRawMode] = useState(false);
  const [draft, setDraft] = useState<AdminConfig | null>(null);
  const [rawJson, setRawJson] = useState('');

  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });

  const saveMutation = useMutation({
    mutationFn: async (nextConfig: AdminConfig) => {
      return saveConfig(auth.token, nextConfig);
    },
    onSuccess: (payload) => {
      setDraft(cloneConfig(payload.config));
      setRawJson(JSON.stringify(payload.config, null, 2));
      toast.success('Runtime config saved.');
    },
    onError: (error) => {
      toast.error('Save failed', (error as Error).message);
    },
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(cloneConfig(configQuery.data.config));
    setRawJson(JSON.stringify(configQuery.data.config, null, 2));
  }, [configQuery.data, draft]);

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading runtime config...</div>;
  }

  if (!draft || !configQuery.data) {
    return <div className="empty-state">Runtime config is unavailable.</div>;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Config"
        actions={
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              const nextMode = !rawMode;
              setRawMode(nextMode);
              if (nextMode) {
                setRawJson(JSON.stringify(draft, null, 2));
              }
            }}
          >
            {rawMode ? 'Back to forms' : 'Raw JSON'}
          </button>
        }
      />

      <Panel
        title="Runtime config"
        subtitle={configQuery.data.path}
        accent="warm"
      >
        {rawMode ? (
          <div className="stack-form">
            <label className="field textarea-field">
              <span>config.json</span>
              <textarea
                className="code-editor"
                rows={24}
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
              />
            </label>
            <div className="button-row">
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(rawJson) as AdminConfig;
                    setDraft(parsed);
                    saveMutation.mutate(parsed);
                  } catch (error) {
                    toast.error(
                      'Invalid JSON',
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                }}
              >
                Save JSON
              </button>
            </div>
          </div>
        ) : (
          <div className="config-grid">
            <section className="config-section">
              <h4>Operations</h4>
              <label className="field">
                <span>Health host</span>
                <input
                  value={draft.ops.healthHost}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ops: {
                              ...current.ops,
                              healthHost: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Health port</span>
                <input
                  value={String(draft.ops.healthPort)}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ops: {
                              ...current.ops,
                              healthPort:
                                Number.parseInt(event.target.value, 10) || 0,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Log level</span>
                <input
                  value={draft.ops.logLevel}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            ops: {
                              ...current.ops,
                              logLevel: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
            </section>

            <section className="config-section">
              <h4>HybridAI</h4>
              <label className="field">
                <span>Base URL</span>
                <input
                  value={draft.hybridai.baseUrl}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            hybridai: {
                              ...current.hybridai,
                              baseUrl: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Default model</span>
                <input
                  value={draft.hybridai.defaultModel}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            hybridai: {
                              ...current.hybridai,
                              defaultModel: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <BooleanField
                label="RAG default"
                value={draft.hybridai.enableRag}
                trueLabel="on"
                falseLabel="off"
                onChange={(enableRag) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          hybridai: {
                            ...current.hybridai,
                            enableRag,
                          },
                        }
                      : current,
                  )
                }
              />
            </section>

            <section className="config-section">
              <h4>Discord</h4>
              <label className="field">
                <span>Prefix</span>
                <input
                  value={draft.discord.prefix}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            discord: {
                              ...current.discord,
                              prefix: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Group policy</span>
                <select
                  value={draft.discord.groupPolicy}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            discord: {
                              ...current.discord,
                              groupPolicy: event.target
                                .value as AdminConfig['discord']['groupPolicy'],
                            },
                          }
                        : current,
                    )
                  }
                >
                  <option value="open">open</option>
                  <option value="allowlist">allowlist</option>
                  <option value="disabled">disabled</option>
                </select>
              </label>
              <BooleanField
                label="Commands only"
                value={draft.discord.commandsOnly}
                trueLabel="on"
                falseLabel="off"
                onChange={(commandsOnly) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          discord: {
                            ...current.discord,
                            commandsOnly,
                          },
                        }
                      : current,
                  )
                }
              />
            </section>

            <section className="config-section">
              <h4>Container</h4>
              <label className="field">
                <span>Sandbox mode</span>
                <select
                  value={draft.container.sandboxMode}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            container: {
                              ...current.container,
                              sandboxMode: event.target
                                .value as AdminConfig['container']['sandboxMode'],
                            },
                          }
                        : current,
                    )
                  }
                >
                  <option value="container">container</option>
                  <option value="host">host</option>
                </select>
              </label>
              <label className="field">
                <span>Image</span>
                <input
                  value={draft.container.image}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            container: {
                              ...current.container,
                              image: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Memory</span>
                <input
                  value={draft.container.memory}
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            container: {
                              ...current.container,
                              memory: event.target.value,
                            },
                          }
                        : current,
                    )
                  }
                />
              </label>
            </section>
          </div>
        )}

        <div className="button-row">
          <button
            className="primary-button"
            type="button"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save config'}
          </button>
        </div>
      </Panel>
    </div>
  );
}
