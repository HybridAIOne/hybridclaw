import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  fetchBrowserPoolHealth,
  fetchConfig,
  saveConfig,
  startBrowserPool,
} from '../api/client';
import type { AdminBrowserPoolHealthResponse, AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import styles from './config.module.css';

function cloneConfig<T>(value: T): T {
  return structuredClone(value);
}

function serialize(config: AdminConfig): string {
  return JSON.stringify(config, null, 2);
}

type AdminConfigSections = {
  ops: AdminConfig['ops'];
  security: AdminConfig['security'];
  hybridai: AdminConfig['hybridai'];
  container: AdminConfig['container'];
};

function updateSection<K extends keyof AdminConfigSections>(
  setDraft: Dispatch<SetStateAction<AdminConfig | null>>,
  section: K,
  updates: Partial<AdminConfigSections[K]>,
) {
  setDraft((current) => {
    if (!current) return current;
    return { ...current, [section]: { ...current[section], ...updates } };
  });
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
    <Input
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
  const [jsonError, setJsonError] = useState<string | null>(null);

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
      setRawJson(serialize(payload.config));
      setJsonError(null);
      toast.success('Runtime config saved.');
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  useEffect(() => {
    if (!configQuery.data || draft) return;
    setDraft(cloneConfig(configQuery.data.config));
    setRawJson(serialize(configQuery.data.config));
  }, [configQuery.data, draft]);

  const savedSerialized = useMemo(
    () => (configQuery.data ? serialize(configQuery.data.config) : ''),
    [configQuery.data],
  );

  const isDirty = useMemo(() => {
    if (!configQuery.data || !draft) return false;
    if (rawMode) return rawJson !== savedSerialized;
    return serialize(draft) !== savedSerialized;
  }, [configQuery.data, draft, rawMode, rawJson, savedSerialized]);

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

  const toggleRawMode = () => {
    if (rawMode) {
      try {
        const parsed = JSON.parse(rawJson) as AdminConfig;
        setDraft(parsed);
        setJsonError(null);
        setRawMode(false);
      } catch (error) {
        setJsonError(getErrorMessage(error));
      }
      return;
    }
    setRawJson(serialize(draft));
    setJsonError(null);
    setRawMode(true);
  };

  const discard = () => {
    if (!configQuery.data) return;
    setDraft(cloneConfig(configQuery.data.config));
    setRawJson(serialize(configQuery.data.config));
    setJsonError(null);
  };

  const save = () => {
    if (rawMode) {
      try {
        const parsed = JSON.parse(rawJson) as AdminConfig;
        setDraft(parsed);
        setJsonError(null);
        saveMutation.mutate(parsed);
      } catch (error) {
        setJsonError(getErrorMessage(error));
      }
      return;
    }
    saveMutation.mutate(draft);
  };

  return (
    <div className={styles.page}>
      <PageHeader
        title="Config"
        description={configQuery.data.path}
        actions={
          <>
            {isDirty ? (
              <>
                <span className={styles.status}>
                  <span className={styles.statusDot} aria-hidden="true" />
                  Unsaved changes
                </span>
                <Button variant="ghost" onClick={discard}>
                  Discard
                </Button>
              </>
            ) : (
              <span className={styles.status}>Saved</span>
            )}
            <Button variant="ghost" onClick={toggleRawMode}>
              {rawMode ? 'Edit as form' : 'Edit as JSON'}
            </Button>
            {isDirty || saveMutation.isPending ? (
              <Button
                loading={saveMutation.isPending}
                disabled={saveMutation.isPending}
                onClick={save}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className={styles.content}>
        {rawMode ? (
          <Field invalid={Boolean(jsonError)}>
            <FieldLabel>config.json</FieldLabel>
            <Textarea
              className="code-editor"
              rows={24}
              value={rawJson}
              onChange={(event) => {
                setRawJson(event.target.value);
                if (jsonError) setJsonError(null);
              }}
            />
            <FieldError>{jsonError}</FieldError>
          </Field>
        ) : (
          <>
            <FieldSet>
              <FieldLegend>Operations</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel>Health host</FieldLabel>
                  <Input
                    value={draft.ops.healthHost}
                    onChange={(event) =>
                      updateSection(setDraft, 'ops', {
                        healthHost: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>Health port</FieldLabel>
                  <Input
                    value={String(draft.ops.healthPort)}
                    onChange={(event) =>
                      updateSection(setDraft, 'ops', {
                        healthPort:
                          Number.parseInt(event.target.value, 10) || 0,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>Log level</FieldLabel>
                  <Input
                    value={draft.ops.logLevel}
                    onChange={(event) =>
                      updateSection(setDraft, 'ops', {
                        logLevel: event.target.value,
                      })
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Security</FieldLegend>
              <FieldGroup>
                <Field orientation="horizontal">
                  <FieldLabel>Confidential leak guard</FieldLabel>
                  <Switch
                    checked={draft.security.confidentialRedactionEnabled}
                    onCheckedChange={(confidentialRedactionEnabled) =>
                      updateSection(setDraft, 'security', {
                        confidentialRedactionEnabled,
                      })
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>HybridAI</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel>Base URL</FieldLabel>
                  <Input
                    value={draft.hybridai.baseUrl}
                    onChange={(event) =>
                      updateSection(setDraft, 'hybridai', {
                        baseUrl: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field>
                  <FieldLabel>Default model</FieldLabel>
                  <Input
                    value={draft.hybridai.defaultModel}
                    onChange={(event) =>
                      updateSection(setDraft, 'hybridai', {
                        defaultModel: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel>RAG default</FieldLabel>
                  <Switch
                    checked={draft.hybridai.enableRag}
                    onCheckedChange={(enableRag) =>
                      updateSection(setDraft, 'hybridai', { enableRag })
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Container</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel>Memory</FieldLabel>
                  <Input
                    value={draft.container.memory}
                    onChange={(event) =>
                      updateSection(setDraft, 'container', {
                        memory: event.target.value,
                      })
                    }
                  />
                </Field>
                <Field orientation="horizontal">
                  <FieldLabel>Persistent bash state</FieldLabel>
                  <Switch
                    checked={draft.container.persistBashState}
                    onCheckedChange={(persistBashState) =>
                      updateSection(setDraft, 'container', { persistBashState })
                    }
                  />
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Browser</FieldLegend>
              <FieldGroup>
                <Field>
                  <FieldLabel>Provider</FieldLabel>
                  <NativeSelect
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
                    <NativeSelectOption value="local">local</NativeSelectOption>
                    <NativeSelectOption value="camofox">
                      camofox
                    </NativeSelectOption>
                    <NativeSelectOption value="managed-cloud">
                      managed-cloud
                    </NativeSelectOption>
                    <NativeSelectOption value="browser-use-cloud">
                      browser-use-cloud
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>

                {browser.provider === 'local' ? (
                  <>
                    <Field>
                      <FieldLabel>Profile directory</FieldLabel>
                      <Input
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
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel>Headed browser</FieldLabel>
                      <Switch
                        checked={browser.local.headed}
                        onCheckedChange={(headed) =>
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
                    </Field>
                  </>
                ) : null}

                {browser.provider === 'camofox' ? (
                  <>
                    <Field>
                      <FieldLabel>Profile directory</FieldLabel>
                      <Input
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
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel>Headed browser</FieldLabel>
                      <Switch
                        checked={browser.camofox.headed}
                        onCheckedChange={(headed) =>
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
                    </Field>
                  </>
                ) : null}

                {browser.provider === 'managed-cloud' ? (
                  <>
                    <Field>
                      <FieldLabel>Pool status</FieldLabel>
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
                        <Button
                          variant="ghost"
                          type="button"
                          disabled={browserPoolHealthQuery.isFetching}
                          onClick={() => void browserPoolHealthQuery.refetch()}
                        >
                          {browserPoolHealthQuery.isFetching
                            ? 'Checking...'
                            : 'Check now'}
                        </Button>
                        <Button
                          variant="ghost"
                          type="button"
                          disabled={startBrowserPoolMutation.isPending}
                          onClick={() => startBrowserPoolMutation.mutate()}
                        >
                          {startBrowserPoolMutation.isPending
                            ? 'Starting...'
                            : 'Start Docker pool'}
                        </Button>
                      </div>
                    </Field>
                    <Field>
                      <FieldLabel>Pool endpoint URL</FieldLabel>
                      <Input
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
                    </Field>
                    <Field>
                      <FieldLabel>Pool token SecretRef id</FieldLabel>
                      <Input
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
                    </Field>
                    <Field>
                      <FieldLabel>Default tenant id (optional)</FieldLabel>
                      <Input
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
                    </Field>
                    <div className="button-row">
                      <a className="ghost-button" href="/admin/approvals">
                        Manage network policy
                      </a>
                    </div>
                    <Field controlId="managed-cloud-action-usd">
                      <FieldLabel>Action price USD</FieldLabel>
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
                    </Field>
                  </>
                ) : null}

                {browser.provider === 'browser-use-cloud' ? (
                  <>
                    <Field>
                      <FieldLabel>API key SecretRef id</FieldLabel>
                      <Input
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
                    </Field>
                    <Field>
                      <FieldLabel>Project id</FieldLabel>
                      <Input
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
                    </Field>
                    <Field>
                      <FieldLabel>Profile id</FieldLabel>
                      <Input
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
                    </Field>
                    <Field>
                      <FieldLabel>Region</FieldLabel>
                      <Input
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
                    </Field>
                    <Field orientation="horizontal">
                      <FieldLabel>Keep alive</FieldLabel>
                      <Switch
                        checked={browser.browserUseCloud.keepAlive}
                        onCheckedChange={(keepAlive) =>
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
                    </Field>
                    <Field controlId="browser-use-browser-usd">
                      <FieldLabel>Browser price USD/min</FieldLabel>
                      <DecimalNumberInput
                        id="browser-use-browser-usd"
                        value={
                          browser.browserUseCloud.pricing.browserUsdPerMinute
                        }
                        onValueChange={(value) =>
                          setDraft((current) =>
                            updateBrowserConfig(current, (currentBrowser) => ({
                              ...currentBrowser,
                              browserUseCloud: {
                                ...currentBrowser.browserUseCloud,
                                pricing: {
                                  ...currentBrowser.browserUseCloud.pricing,
                                  browserUsdPerMinute: value,
                                },
                              },
                            })),
                          )
                        }
                      />
                    </Field>
                    <Field controlId="browser-use-action-usd">
                      <FieldLabel>Action price USD</FieldLabel>
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
                    </Field>
                  </>
                ) : null}
              </FieldGroup>
            </FieldSet>
          </>
        )}
      </div>
    </div>
  );
}
