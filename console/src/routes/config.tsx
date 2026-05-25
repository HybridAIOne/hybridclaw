import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  fetchBrowserPoolHealth,
  fetchConfig,
  saveConfig,
  startBrowserPool,
} from '../api/client';
import type { AdminBrowserPoolHealthResponse, AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { useToast } from '../components/toast';
import { BooleanField, PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

type BrowserConfig = NonNullable<AdminConfig['browser']>;
type BrowserProvider = BrowserConfig['provider'];
const LOCAL_DOCKER_POOL_TENANT_ID = 'main';

function DecimalNumberInput({
  id,
  value,
  onValueChange,
}: {
  id: string;
  value: number;
  onValueChange: (value: number) => void;
}) {
  const [rawValue, setRawValue] = useState(String(value));

  useEffect(() => {
    setRawValue(String(value));
  }, [value]);

  return (
    <input
      id={id}
      inputMode="decimal"
      value={rawValue}
      onBlur={() => {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) {
          setRawValue(String(value));
        }
      }}
      onChange={(event) => {
        const nextValue = event.target.value;
        setRawValue(nextValue);
        if (nextValue.trim() === '') {
          onValueChange(0);
          return;
        }
        const parsed = Number(nextValue);
        if (Number.isFinite(parsed) && parsed >= 0) {
          onValueChange(parsed);
        }
      }}
    />
  );
}

function defaultBrowserConfig(): BrowserConfig {
  return {
    provider: 'local',
    allowPrivateNetwork: false,
    local: {
      profileDir: '',
      headed: false,
    },
    camofox: {
      profileDir: '',
      headed: false,
    },
    managedCloud: {
      endpointUrl: 'http://127.0.0.1:8787',
      poolTokenRef: undefined,
      defaultTenantId: '',
      pricing: {
        actionUsd: 0,
      },
    },
    browserUseCloud: {
      apiKeyRef: undefined,
      projectId: '',
      profileId: '',
      region: '',
      keepAlive: false,
      pricing: {
        browserUsdPerMinute: 0,
        actionUsd: 0,
      },
    },
  };
}

function isLoopbackBrowserEndpoint(endpointUrl: string): boolean {
  try {
    const parsed = new URL(endpointUrl);
    const hostname = parsed.hostname.toLowerCase();
    return (
      parsed.protocol === 'http:' &&
      (hostname === 'localhost' ||
        hostname === '127.0.0.1' ||
        hostname === '::1')
    );
  } catch {
    return false;
  }
}

function applyLocalDockerPoolTenantDefault(
  browser: BrowserConfig,
): BrowserConfig {
  if (
    browser.provider !== 'managed-cloud' ||
    !isLoopbackBrowserEndpoint(browser.managedCloud.endpointUrl) ||
    browser.managedCloud.defaultTenantId.trim()
  ) {
    return browser;
  }
  return {
    ...browser,
    managedCloud: {
      ...browser.managedCloud,
      defaultTenantId: LOCAL_DOCKER_POOL_TENANT_ID,
    },
  };
}

function browserConfig(config: AdminConfig): BrowserConfig {
  return applyLocalDockerPoolTenantDefault({
    ...defaultBrowserConfig(),
    ...(config.browser ?? {}),
    local: {
      ...defaultBrowserConfig().local,
      ...(config.browser?.local ?? {}),
    },
    camofox: {
      ...defaultBrowserConfig().camofox,
      ...(config.browser?.camofox ?? {}),
    },
    managedCloud: {
      ...defaultBrowserConfig().managedCloud,
      ...(config.browser?.managedCloud ?? {}),
      pricing: {
        ...defaultBrowserConfig().managedCloud.pricing,
        ...(config.browser?.managedCloud?.pricing ?? {}),
      },
    },
    browserUseCloud: {
      ...defaultBrowserConfig().browserUseCloud,
      ...(config.browser?.browserUseCloud ?? {}),
      pricing: {
        ...defaultBrowserConfig().browserUseCloud.pricing,
        ...(config.browser?.browserUseCloud?.pricing ?? {}),
      },
    },
  });
}

function updateBrowserConfig(
  current: AdminConfig | null,
  updater: (browser: BrowserConfig) => BrowserConfig,
): AdminConfig | null {
  if (!current) return current;
  return {
    ...current,
    browser: updater(browserConfig(current)),
  };
}

function browserPoolStatusClass(
  health: AdminBrowserPoolHealthResponse | undefined,
): string {
  if (!health) return 'list-status';
  if (health.status === 'online') return 'list-status list-status-success';
  if (health.status === 'offline') return 'list-status list-status-danger';
  return 'list-status list-status-warning';
}

function browserPoolDotClass(
  health: AdminBrowserPoolHealthResponse | undefined,
): string {
  if (!health) return 'status-dot';
  if (health.status === 'online') return 'status-dot status-dot-success';
  if (health.status === 'offline') return 'status-dot status-dot-danger';
  return 'status-dot status-dot-warning';
}

function browserPoolStatusText(
  health: AdminBrowserPoolHealthResponse | undefined,
  isLoading: boolean,
): string {
  if (isLoading) return 'checking';
  if (!health) return 'not checked';
  if (health.status === 'online') {
    return `online - ${health.healthyNodeCount}/${health.nodeCount} nodes healthy`;
  }
  return `${health.status} - ${health.message}`;
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
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(cloneConfig(configQuery.data.config));
    setRawJson(JSON.stringify(configQuery.data.config, null, 2));
  }, [configQuery.data, draft]);

  const draftBrowser = draft ? browserConfig(draft) : defaultBrowserConfig();
  const managedPoolTokenId = draftBrowser.managedCloud.poolTokenRef?.id ?? '';
  const browserUseApiKeyId = draftBrowser.browserUseCloud.apiKeyRef?.id ?? '';
  const browserPoolHealthQuery = useQuery({
    queryKey: [
      'browser-pool-health',
      auth.token,
      draftBrowser.provider,
      draftBrowser.managedCloud.endpointUrl,
    ],
    queryFn: () => fetchBrowserPoolHealth(auth.token),
    enabled: Boolean(
      draft && !rawMode && draftBrowser.provider === 'managed-cloud',
    ),
    refetchInterval: 15_000,
  });
  const browserPoolHealth = browserPoolHealthQuery.data;
  const startBrowserPoolMutation = useMutation({
    mutationFn: () => startBrowserPool(auth.token),
    onSuccess: (payload) => {
      if (payload.ok) {
        toast.success('Browser pool start requested.', payload.message);
      } else {
        toast.error('Browser pool did not start', payload.message);
      }
      if (payload.poolTokenRefId) {
        const poolTokenRefId = payload.poolTokenRefId;
        setDraft((current) =>
          updateBrowserConfig(current, (currentBrowser) => ({
            ...currentBrowser,
            managedCloud: {
              ...currentBrowser.managedCloud,
              poolTokenRef: {
                source: 'store',
                id: poolTokenRefId,
              },
            },
          })),
        );
      }
      void configQuery.refetch();
      void browserPoolHealthQuery.refetch();
    },
    onError: (error) => {
      toast.error('Browser pool start failed', getErrorMessage(error));
    },
  });
  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading runtime config...</div>;
  }

  if (!draft || !configQuery.data) {
    return <div className="empty-state">Runtime config is unavailable.</div>;
  }

  const browser = draftBrowser;

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

      <Card variant="muted">
        <CardHeader>
          <CardTitle>Runtime config</CardTitle>
          <CardDescription>{configQuery.data.path}</CardDescription>
        </CardHeader>
        <CardContent>
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
                      toast.error('Invalid JSON', getErrorMessage(error));
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
                <h4>Security</h4>
                <BooleanField
                  label="Confidential leak guard"
                  value={draft.security?.confidentialRedactionEnabled ?? false}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(confidentialRedactionEnabled) =>
                    setDraft((current) => {
                      if (!current) return current;
                      const security = current.security ?? {
                        trustModelAccepted: false,
                        trustModelAcceptedAt: '',
                        trustModelVersion: '',
                        trustModelAcceptedBy: '',
                        confidentialRedactionEnabled: false,
                      };
                      return {
                        ...current,
                        security: {
                          ...security,
                          confidentialRedactionEnabled,
                        },
                      };
                    })
                  }
                />
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
                <h4>Container</h4>
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
                <BooleanField
                  label="Persistent bash state"
                  value={draft.container.persistBashState}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(persistBashState) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            container: {
                              ...current.container,
                              persistBashState,
                            },
                          }
                        : current,
                    )
                  }
                />
              </section>

              <section className="config-section">
                <h4>Browser</h4>
                <label className="field">
                  <span>Provider</span>
                  <select
                    value={browser.provider}
                    onChange={(event) =>
                      setDraft((current) =>
                        updateBrowserConfig(current, (currentBrowser) => ({
                          ...currentBrowser,
                          provider: event.target.value as BrowserProvider,
                        })),
                      )
                    }
                  >
                    <option value="local">local</option>
                    <option value="camofox">camofox</option>
                    <option value="managed-cloud">managed-cloud</option>
                    <option value="browser-use-cloud">browser-use-cloud</option>
                  </select>
                </label>
                <BooleanField
                  label="Allow private network navigation"
                  value={browser.allowPrivateNetwork}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(allowPrivateNetwork) =>
                    setDraft((current) =>
                      updateBrowserConfig(current, (currentBrowser) => ({
                        ...currentBrowser,
                        allowPrivateNetwork,
                      })),
                    )
                  }
                />
                {browser.provider === 'local' ? (
                  <>
                    <label className="field">
                      <span>Profile directory</span>
                      <input
                        value={browser.local.profileDir}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              local: {
                                ...currentBrowser.local,
                                profileDir: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <BooleanField
                      label="Headed browser"
                      value={browser.local.headed}
                      trueLabel="on"
                      falseLabel="off"
                      onChange={(headed) =>
                        setDraft((current) =>
                          updateBrowserConfig(current, (currentBrowser) => ({
                            ...currentBrowser,
                            local: {
                              ...currentBrowser.local,
                              headed,
                            },
                          })),
                        )
                      }
                    />
                  </>
                ) : null}
                {browser.provider === 'camofox' ? (
                  <>
                    <label className="field">
                      <span>Profile directory</span>
                      <input
                        value={browser.camofox.profileDir}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              camofox: {
                                ...currentBrowser.camofox,
                                profileDir: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <BooleanField
                      label="Headed browser"
                      value={browser.camofox.headed}
                      trueLabel="on"
                      falseLabel="off"
                      onChange={(headed) =>
                        setDraft((current) =>
                          updateBrowserConfig(current, (currentBrowser) => ({
                            ...currentBrowser,
                            camofox: {
                              ...currentBrowser.camofox,
                              headed,
                            },
                          })),
                        )
                      }
                    />
                  </>
                ) : null}
                {browser.provider === 'managed-cloud' ? (
                  <>
                    <div className="field">
                      <span>Pool status</span>
                      <div className="button-row">
                        <span
                          className={browserPoolStatusClass(browserPoolHealth)}
                        >
                          <span
                            className={browserPoolDotClass(browserPoolHealth)}
                          />
                          {browserPoolStatusText(
                            browserPoolHealth,
                            browserPoolHealthQuery.isLoading,
                          )}
                        </span>
                        <button
                          className="ghost-button"
                          type="button"
                          disabled={browserPoolHealthQuery.isFetching}
                          onClick={() => void browserPoolHealthQuery.refetch()}
                        >
                          {browserPoolHealthQuery.isFetching
                            ? 'Checking...'
                            : 'Check now'}
                        </button>
                        <button
                          className="ghost-button"
                          type="button"
                          disabled={startBrowserPoolMutation.isPending}
                          onClick={() => startBrowserPoolMutation.mutate()}
                        >
                          {startBrowserPoolMutation.isPending
                            ? 'Starting...'
                            : 'Start Docker pool'}
                        </button>
                      </div>
                    </div>
                    <label className="field">
                      <span>Pool endpoint URL</span>
                      <input
                        value={browser.managedCloud.endpointUrl}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              managedCloud: {
                                ...currentBrowser.managedCloud,
                                endpointUrl: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Pool token SecretRef id</span>
                      <input
                        value={managedPoolTokenId}
                        placeholder="MANAGED_BROWSER_POOL_TOKEN"
                        onChange={(event) => {
                          const id = event.target.value.trim();
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              managedCloud: {
                                ...currentBrowser.managedCloud,
                                poolTokenRef: id
                                  ? {
                                      source: 'store',
                                      id,
                                    }
                                  : undefined,
                              },
                            })),
                          );
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Default tenant id (optional)</span>
                      <input
                        value={browser.managedCloud.defaultTenantId}
                        placeholder="Uses agent id when blank"
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              managedCloud: {
                                ...currentBrowser.managedCloud,
                                defaultTenantId: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <div className="button-row">
                      <a className="ghost-button" href="/admin/approvals">
                        Manage network policy
                      </a>
                    </div>
                    <label className="field" htmlFor="managed-cloud-action-usd">
                      <span>Action price USD</span>
                      <DecimalNumberInput
                        id="managed-cloud-action-usd"
                        value={browser.managedCloud.pricing.actionUsd}
                        onValueChange={(value) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              managedCloud: {
                                ...currentBrowser.managedCloud,
                                pricing: {
                                  ...currentBrowser.managedCloud.pricing,
                                  actionUsd: value,
                                },
                              },
                            })),
                          )
                        }
                      />
                    </label>
                  </>
                ) : null}
                {browser.provider === 'browser-use-cloud' ? (
                  <>
                    <label className="field">
                      <span>API key SecretRef id</span>
                      <input
                        value={browserUseApiKeyId}
                        onChange={(event) => {
                          const id = event.target.value.trim();
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                apiKeyRef: id
                                  ? {
                                      source: 'store',
                                      id,
                                    }
                                  : undefined,
                              },
                            })),
                          );
                        }}
                      />
                    </label>
                    <label className="field">
                      <span>Project id</span>
                      <input
                        value={browser.browserUseCloud.projectId}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                projectId: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Profile id</span>
                      <input
                        value={browser.browserUseCloud.profileId}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                profileId: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <label className="field">
                      <span>Region</span>
                      <input
                        value={browser.browserUseCloud.region}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                region: event.target.value,
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <BooleanField
                      label="Keep alive"
                      value={browser.browserUseCloud.keepAlive}
                      trueLabel="on"
                      falseLabel="off"
                      onChange={(keepAlive) =>
                        setDraft((current) =>
                          updateBrowserConfig(current, (currentBrowser) => ({
                            ...currentBrowser,
                            browserUseCloud: {
                              ...currentBrowser.browserUseCloud,
                              keepAlive,
                            },
                          })),
                        )
                      }
                    />
                    <label className="field">
                      <span>Browser price USD/min</span>
                      <input
                        inputMode="decimal"
                        value={String(
                          browser.browserUseCloud.pricing.browserUsdPerMinute,
                        )}
                        onChange={(event) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                pricing: {
                                  ...currentBrowser.browserUseCloud.pricing,
                                  browserUsdPerMinute:
                                    Number(event.target.value) || 0,
                                },
                              },
                            })),
                          )
                        }
                      />
                    </label>
                    <label className="field" htmlFor="browser-use-action-usd">
                      <span>Action price USD</span>
                      <DecimalNumberInput
                        id="browser-use-action-usd"
                        value={browser.browserUseCloud.pricing.actionUsd}
                        onValueChange={(value) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                pricing: {
                                  ...currentBrowser.browserUseCloud.pricing,
                                  actionUsd: value,
                                },
                              },
                            })),
                          )
                        }
                      />
                    </label>
                  </>
                ) : null}
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
        </CardContent>
      </Card>
    </div>
  );
}
