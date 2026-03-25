import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanField,
  Button,
  EmptyState,
  FormField,
  PageHeader,
  Panel,
} from '../components/ui';

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

export function ConfigPage() {
  const auth = useAuth();
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
    },
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(cloneConfig(configQuery.data.config));
    setRawJson(JSON.stringify(configQuery.data.config, null, 2));
  }, [configQuery.data, draft]);

  if (configQuery.isLoading && !draft) {
    return <EmptyState>Loading runtime config...</EmptyState>;
  }

  if (!draft || !configQuery.data) {
    return <EmptyState>Runtime config is unavailable.</EmptyState>;
  }

  return (
    <div className="page-stack">
      <PageHeader
        title="Config"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              const nextMode = !rawMode;
              setRawMode(nextMode);
              if (nextMode) {
                setRawJson(JSON.stringify(draft, null, 2));
              }
            }}
          >
            {rawMode ? 'Back to forms' : 'Raw JSON'}
          </Button>
        }
      />

      <Panel
        title="Runtime config"
        subtitle={configQuery.data.path}
        accent="warm"
      >
        {rawMode ? (
          <div className="stack-form">
            <FormField label="config.json">
              <textarea
                className="code-editor"
                rows={24}
                value={rawJson}
                onChange={(event) => setRawJson(event.target.value)}
              />
            </FormField>
            <div className="button-row">
              <Button
                variant="primary"
                onClick={() => {
                  try {
                    const parsed = JSON.parse(rawJson) as AdminConfig;
                    setDraft(parsed);
                    saveMutation.mutate(parsed);
                  } catch (error) {
                    window.alert(
                      error instanceof Error ? error.message : String(error),
                    );
                  }
                }}
              >
                Save JSON
              </Button>
            </div>
          </div>
        ) : (
          <div className="config-grid">
            <section className="config-section">
              <h4>Operations</h4>
              <FormField label="Health host">
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
              </FormField>
              <FormField label="Health port">
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
              </FormField>
              <FormField label="Log level">
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
              </FormField>
            </section>

            <section className="config-section">
              <h4>HybridAI</h4>
              <FormField label="Base URL">
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
              </FormField>
              <FormField label="Default model">
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
              </FormField>
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
              <FormField label="Prefix">
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
              </FormField>
              <FormField label="Group policy">
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
              </FormField>
              <BooleanField
                label="Respond to all messages"
                value={draft.discord.respondToAllMessages}
                trueLabel="on"
                falseLabel="off"
                onChange={(respondToAllMessages) =>
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          discord: {
                            ...current.discord,
                            respondToAllMessages,
                          },
                        }
                      : current,
                  )
                }
              />
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
              <FormField label="Sandbox mode">
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
              </FormField>
              <FormField label="Image">
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
              </FormField>
              <FormField label="Memory">
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
              </FormField>
            </section>
          </div>
        )}

        <div className="button-row">
          <Button
            variant="primary"
            disabled={saveMutation.isPending}
            onClick={() => saveMutation.mutate(draft)}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save config'}
          </Button>
        </div>
        {saveMutation.isSuccess ? (
          <Banner variant="success">Runtime config saved.</Banner>
        ) : null}
        {saveMutation.isError ? (
          <Banner variant="error">
            {(saveMutation.error as Error).message}
          </Banner>
        ) : null}
      </Panel>
    </div>
  );
}
