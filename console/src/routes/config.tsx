import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useState,
} from 'react';
import {
  fetchBrowserPoolHealth,
  fetchConfig,
  saveConfig,
  startBrowserPool,
} from '../api/client';
import type {
  AdminBrowserPoolHealthResponse,
  AdminConfig,
  LogLevel,
} from '../api/types';
import { LOG_LEVELS } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  pattern,
  required,
  useFieldError,
} from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { useFormDraft } from '../hooks/use-form-draft';
import { useFormMutation } from '../hooks/use-form-mutation';
import { useUnsavedChangesGuard } from '../hooks/use-unsaved-changes-guard';
import { getErrorMessage } from '../lib/error-message';
import styles from './config.module.css';

function serialize(config: AdminConfig): string {
  return JSON.stringify(config, null, 2);
}

type AdminConfigSections = {
  ops: AdminConfig['ops'];
  security: AdminConfig['security'];
  hybridai: AdminConfig['hybridai'];
  container: AdminConfig['container'];
};

type DraftSetter = Dispatch<SetStateAction<AdminConfig | null>>;

function updateSection<K extends keyof AdminConfigSections>(
  setDraft: DraftSetter,
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
type BrowserObjectSection = Exclude<keyof BrowserConfig, 'provider'>;
const LOCAL_DOCKER_POOL_TENANT_ID = 'main';

const PROVIDER_OPTIONS: ReadonlyArray<{
  value: BrowserProvider;
  label: string;
}> = [
  { value: 'local', label: 'Local (Playwright)' },
  { value: 'camofox', label: 'Camoufox (anti-detection)' },
  { value: 'managed-cloud', label: 'Managed cloud (Docker pool)' },
  { value: 'browser-use-cloud', label: 'Browser Use cloud' },
];

const CONTAINER_MEMORY_PATTERN = /^\d+(?:\.\d+)?[kKmMgG]?$/;

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
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

function withBrowser(
  current: AdminConfig | null,
  updater: (browser: BrowserConfig) => BrowserConfig,
): AdminConfig | null {
  if (!current) return current;
  return { ...current, browser: updater(browserConfig(current)) };
}

function setBrowserSection<K extends BrowserObjectSection>(
  setDraft: DraftSetter,
  section: K,
  updates: Partial<BrowserConfig[K]>,
) {
  setDraft((current) =>
    withBrowser(current, (b) => ({
      ...b,
      [section]: { ...b[section], ...updates },
    })),
  );
}

type BrowserPricedSection = 'managedCloud' | 'browserUseCloud';
type BrowserPricing<K extends BrowserPricedSection> =
  BrowserConfig[K]['pricing'];

function setBrowserPricing<K extends BrowserPricedSection>(
  setDraft: DraftSetter,
  section: K,
  updates: Partial<BrowserPricing<K>>,
) {
  setDraft((current) =>
    withBrowser(current, (b) => ({
      ...b,
      [section]: {
        ...b[section],
        pricing: { ...b[section].pricing, ...updates },
      },
    })),
  );
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

function ProfileBrowserFields({
  provider,
  config,
  setDraft,
}: {
  provider: 'local' | 'camofox';
  config: BrowserConfig['local'];
  setDraft: DraftSetter;
}) {
  return (
    <>
      <Field>
        <FieldLabel>Profile directory</FieldLabel>
        <Input
          value={config.profileDir}
          onChange={(event) =>
            setBrowserSection(setDraft, provider, {
              profileDir: event.target.value,
            })
          }
        />
      </Field>
      <Field orientation="horizontal">
        <Switch
          checked={config.headed}
          onCheckedChange={(headed) =>
            setBrowserSection(setDraft, provider, { headed })
          }
        />
        <FieldContent>
          <FieldLabel>Headed browser</FieldLabel>
          <FieldDescription>
            Show the browser window instead of running headless.
          </FieldDescription>
        </FieldContent>
      </Field>
    </>
  );
}

export function ConfigPage() {
  const auth = useAuth();
  const toast = useToast();
  const [viewMode, setViewMode] = useState<'form' | 'json'>('form');
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [portError, setPortError] = useState<string | null>(null);
  const [managedActionPriceError, setManagedActionPriceError] = useState<
    string | null
  >(null);
  const [browserUseBrowserPriceError, setBrowserUseBrowserPriceError] =
    useState<string | null>(null);
  const [browserUseActionPriceError, setBrowserUseActionPriceError] = useState<
    string | null
  >(null);

  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });

  const {
    draft,
    setDraft,
    isDirty: formIsDirty,
    discard: discardDraft,
    commit: commitDraft,
  } = useFormDraft({ source: configQuery.data?.config });

  const savedSerialized = useMemo(
    () => (configQuery.data ? serialize(configQuery.data.config) : ''),
    [configQuery.data],
  );

  // Hydrate the JSON editor buffer whenever the saved config first arrives
  // or changes from underneath us, so the textarea matches `draft` on mount.
  if (configQuery.data && rawJson === '' && savedSerialized !== '') {
    setRawJson(savedSerialized);
  }

  const isDirty =
    viewMode === 'json' ? rawJson !== savedSerialized : formIsDirty;

  const saveMutation = useFormMutation({
    mutationFn: (nextConfig: AdminConfig) => saveConfig(auth.token, nextConfig),
    onSuccess: (payload) => {
      commitDraft(payload.config);
      setRawJson(serialize(payload.config));
      setJsonError(null);
      toast.success('Runtime config saved.');
    },
    onError: (error) => {
      toast.error('Save failed', error.message);
    },
  });

  const draftBrowser = draft ? browserConfig(draft) : defaultBrowserConfig();
  const savedBrowserProvider =
    configQuery.data?.config.browser?.provider ?? 'local';
  const providerChanged = draftBrowser.provider !== savedBrowserProvider;
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
      draft && viewMode === 'form' && draftBrowser.provider === 'managed-cloud',
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
        setBrowserSection(setDraft, 'managedCloud', {
          poolTokenRef: { source: 'store', id: payload.poolTokenRefId },
        });
      }
      void configQuery.refetch();
      void browserPoolHealthQuery.refetch();
    },
    onError: (error) => {
      toast.error('Browser pool start failed', getErrorMessage(error));
    },
  });

  const handleRawJsonChange = useCallback((next: string) => {
    setRawJson(next);
    try {
      JSON.parse(next);
      setJsonError(null);
    } catch (error) {
      setJsonError(getErrorMessage(error));
    }
  }, []);

  const { dialog: unsavedChangesDialog } = useUnsavedChangesGuard({
    isDirty,
    description:
      'You have unsaved edits to the runtime config. Leaving this page will discard them.',
  });

  const memoryError = useFieldError(draft?.container.memory ?? '', [
    required(),
    pattern(
      CONTAINER_MEMORY_PATTERN,
      'Use a number with optional k, m, or g suffix.',
    ),
  ]);

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading runtime config…</div>;
  }

  if (!draft || !configQuery.data) {
    return (
      <div className={styles.unavailable}>
        <p>Runtime config is unavailable.</p>
        <Button
          variant="ghost"
          onClick={() => void configQuery.refetch()}
          disabled={configQuery.isFetching}
        >
          {configQuery.isFetching ? 'Retrying…' : 'Retry'}
        </Button>
      </div>
    );
  }

  const browser = draftBrowser;

  const handleViewModeChange = (next: string) => {
    const target = next === 'json' ? 'json' : 'form';
    if (target === viewMode) return;
    if (target === 'form') {
      try {
        const parsed = JSON.parse(rawJson) as AdminConfig;
        setDraft(parsed);
        setJsonError(null);
        setViewMode('form');
      } catch (error) {
        setJsonError(getErrorMessage(error));
      }
      return;
    }
    setRawJson(serialize(draft));
    setJsonError(null);
    setViewMode('json');
  };

  const discard = () => {
    discardDraft();
    if (configQuery.data) setRawJson(serialize(configQuery.data.config));
    setJsonError(null);
  };

  const save = () => {
    if (viewMode === 'json') {
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

  const formInvalid =
    Boolean(memoryError) ||
    Boolean(portError) ||
    Boolean(managedActionPriceError) ||
    Boolean(browserUseBrowserPriceError) ||
    Boolean(browserUseActionPriceError);

  const saveDisabled =
    saveMutation.isPending ||
    (viewMode === 'json' ? Boolean(jsonError) : formInvalid);

  return (
    <div className={styles.page}>
      <PageHeader
        description={
          <>
            <span className={styles.path}>{configQuery.data.path}</span>
            {isDirty ? (
              <span className={styles.statusInline}>
                <span className={styles.statusDot} aria-hidden="true" />
                Unsaved changes
              </span>
            ) : (
              <span className={styles.statusInline}>Saved</span>
            )}
          </>
        }
        actions={
          <>
            <ToggleGroup
              ariaLabel="Editor view"
              value={viewMode}
              onValueChange={handleViewModeChange}
              size="sm"
            >
              <ToggleGroupItem value="form">Form</ToggleGroupItem>
              <ToggleGroupItem value="json">JSON</ToggleGroupItem>
            </ToggleGroup>
            {isDirty ? (
              <Button variant="ghost" onClick={discard}>
                Discard
              </Button>
            ) : null}
            {isDirty || saveMutation.isPending ? (
              <Button
                loading={saveMutation.isPending}
                disabled={saveDisabled}
                onClick={save}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </>
        }
      />

      <p className={styles.formNote}>
        Form covers core runtime fields. For the full schema (channels,
        deployment, plugins, scheduler…) switch to <strong>JSON</strong>.
      </p>

      <div className={styles.content}>
        {viewMode === 'json' ? (
          <Field invalid={Boolean(jsonError)}>
            <FieldLabel>config.json</FieldLabel>
            <Textarea
              className={`code-editor ${styles.jsonEditor}`}
              spellCheck={false}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              value={rawJson}
              onChange={(event) => handleRawJsonChange(event.target.value)}
            />
            <FieldError>{jsonError}</FieldError>
          </Field>
        ) : (
          <>
            <FieldSet>
              <FieldLegend>Operations</FieldLegend>
              <FieldDescription className={styles.sectionDescription}>
                Gateway listener and log verbosity.
              </FieldDescription>
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
                  <FieldDescription>
                    Interface the gateway binds to. Use <code>127.0.0.1</code>{' '}
                    for loopback-only.
                  </FieldDescription>
                </Field>
                <Field controlId="ops-health-port" invalid={Boolean(portError)}>
                  <FieldLabel>Health port</FieldLabel>
                  <NumberField
                    id="ops-health-port"
                    integer
                    min={1}
                    max={65535}
                    value={draft.ops.healthPort}
                    onValueChange={(healthPort) =>
                      updateSection(setDraft, 'ops', { healthPort })
                    }
                    onErrorChange={setPortError}
                  />
                  <FieldError>{portError}</FieldError>
                </Field>
                <Field>
                  <FieldLabel>Log level</FieldLabel>
                  <NativeSelect
                    value={draft.ops.logLevel}
                    onChange={(event) => {
                      const next = event.target.value;
                      if (isLogLevel(next)) {
                        updateSection(setDraft, 'ops', { logLevel: next });
                      }
                    }}
                  >
                    {LOG_LEVELS.map((level) => (
                      <NativeSelectOption key={level} value={level}>
                        {level}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Security</FieldLegend>
              <FieldDescription className={styles.sectionDescription}>
                Sensitive-content guards applied to agent output.
              </FieldDescription>
              <FieldGroup>
                <Field orientation="horizontal">
                  <Switch
                    checked={draft.security.confidentialRedactionEnabled}
                    onCheckedChange={(confidentialRedactionEnabled) =>
                      updateSection(setDraft, 'security', {
                        confidentialRedactionEnabled,
                      })
                    }
                  />
                  <FieldContent>
                    <FieldLabel>Confidential leak guard</FieldLabel>
                    <FieldDescription>
                      Redact secrets and sensitive patterns before they leave
                      the agent.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>HybridAI</FieldLegend>
              <FieldDescription className={styles.sectionDescription}>
                HybridAI provider defaults.
              </FieldDescription>
              <FieldGroup>
                <Field>
                  <FieldLabel>Base URL</FieldLabel>
                  <Input
                    type="url"
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
                  <Switch
                    checked={draft.hybridai.enableRag}
                    onCheckedChange={(enableRag) =>
                      updateSection(setDraft, 'hybridai', { enableRag })
                    }
                  />
                  <FieldContent>
                    <FieldLabel>RAG default</FieldLabel>
                    <FieldDescription>
                      Enable retrieval augmentation by default for new
                      conversations.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Container</FieldLegend>
              <FieldDescription className={styles.sectionDescription}>
                Sandboxed container runtime for tool execution.
              </FieldDescription>
              <FieldGroup>
                <Field
                  controlId="container-memory"
                  invalid={Boolean(memoryError)}
                >
                  <FieldLabel>Memory</FieldLabel>
                  <Input
                    id="container-memory"
                    value={draft.container.memory}
                    placeholder="1024m"
                    onChange={(event) =>
                      updateSection(setDraft, 'container', {
                        memory: event.target.value,
                      })
                    }
                  />
                  <FieldDescription>
                    Docker memory limit. e.g. <code>512m</code>, <code>1g</code>
                    , <code>2048m</code>.
                  </FieldDescription>
                  <FieldError>{memoryError}</FieldError>
                </Field>
                <Field orientation="horizontal">
                  <Switch
                    checked={draft.container.persistBashState}
                    onCheckedChange={(persistBashState) =>
                      updateSection(setDraft, 'container', { persistBashState })
                    }
                  />
                  <FieldContent>
                    <FieldLabel>Persistent bash state</FieldLabel>
                    <FieldDescription>
                      Reuse the same shell across tool calls so cwd, env, and
                      aliases survive.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </FieldGroup>
            </FieldSet>

            <FieldSet>
              <FieldLegend>Browser</FieldLegend>
              <FieldDescription className={styles.sectionDescription}>
                Browser provider used for agent web tasks.
              </FieldDescription>
              <FieldGroup>
                <Field>
                  <FieldLabel>Provider</FieldLabel>
                  <NativeSelect
                    value={browser.provider}
                    onChange={(event) =>
                      setDraft((current) =>
                        withBrowser(current, (b) => ({
                          ...b,
                          provider: event.target.value as BrowserProvider,
                        })),
                      )
                    }
                  >
                    {PROVIDER_OPTIONS.map((option) => (
                      <NativeSelectOption
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>

                {browser.provider === 'local' ? (
                  <ProfileBrowserFields
                    provider="local"
                    config={browser.local}
                    setDraft={setDraft}
                  />
                ) : null}

                {browser.provider === 'camofox' ? (
                  <ProfileBrowserFields
                    provider="camofox"
                    config={browser.camofox}
                    setDraft={setDraft}
                  />
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
                      {providerChanged ? (
                        <FieldDescription className={styles.poolStatusPending}>
                          Pending save — status above reflects the previously
                          saved provider ({savedBrowserProvider}). Save changes
                          to refresh.
                        </FieldDescription>
                      ) : null}
                    </Field>
                    <Field>
                      <FieldLabel>Pool endpoint URL</FieldLabel>
                      <Input
                        type="url"
                        value={browser.managedCloud.endpointUrl}
                        onChange={(event) =>
                          setBrowserSection(setDraft, 'managedCloud', {
                            endpointUrl: event.target.value,
                          })
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
                          setBrowserSection(setDraft, 'managedCloud', {
                            poolTokenRef: id
                              ? { source: 'store', id }
                              : undefined,
                          });
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Default tenant id (optional)</FieldLabel>
                      <Input
                        value={browser.managedCloud.defaultTenantId}
                        placeholder="Uses agent id when blank"
                        onChange={(event) =>
                          setBrowserSection(setDraft, 'managedCloud', {
                            defaultTenantId: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <div className="button-row">
                      <Link to="/admin/approvals" className="ghost-button">
                        Manage network policy
                      </Link>
                    </div>
                    <Field
                      controlId="managed-cloud-action-usd"
                      invalid={Boolean(managedActionPriceError)}
                    >
                      <FieldLabel>Action price USD</FieldLabel>
                      <NumberField
                        id="managed-cloud-action-usd"
                        min={0}
                        emptyValue={0}
                        value={browser.managedCloud.pricing.actionUsd}
                        onValueChange={(actionUsd) =>
                          setBrowserPricing(setDraft, 'managedCloud', {
                            actionUsd,
                          })
                        }
                        onErrorChange={setManagedActionPriceError}
                      />
                      <FieldError>{managedActionPriceError}</FieldError>
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
                          setBrowserSection(setDraft, 'browserUseCloud', {
                            apiKeyRef: id ? { source: 'store', id } : undefined,
                          });
                        }}
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Project id</FieldLabel>
                      <Input
                        value={browser.browserUseCloud.projectId}
                        onChange={(event) =>
                          setBrowserSection(setDraft, 'browserUseCloud', {
                            projectId: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Profile id</FieldLabel>
                      <Input
                        value={browser.browserUseCloud.profileId}
                        onChange={(event) =>
                          setBrowserSection(setDraft, 'browserUseCloud', {
                            profileId: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field>
                      <FieldLabel>Region</FieldLabel>
                      <Input
                        value={browser.browserUseCloud.region}
                        onChange={(event) =>
                          setBrowserSection(setDraft, 'browserUseCloud', {
                            region: event.target.value,
                          })
                        }
                      />
                    </Field>
                    <Field orientation="horizontal">
                      <Switch
                        checked={browser.browserUseCloud.keepAlive}
                        onCheckedChange={(keepAlive) =>
                          setBrowserSection(setDraft, 'browserUseCloud', {
                            keepAlive,
                          })
                        }
                      />
                      <FieldContent>
                        <FieldLabel>Keep alive</FieldLabel>
                        <FieldDescription>
                          Keep the cloud browser session alive between calls
                          instead of tearing it down.
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                    <Field
                      controlId="browser-use-browser-usd"
                      invalid={Boolean(browserUseBrowserPriceError)}
                    >
                      <FieldLabel>Browser price USD/min</FieldLabel>
                      <NumberField
                        id="browser-use-browser-usd"
                        min={0}
                        emptyValue={0}
                        value={
                          browser.browserUseCloud.pricing.browserUsdPerMinute
                        }
                        onValueChange={(browserUsdPerMinute) =>
                          setBrowserPricing(setDraft, 'browserUseCloud', {
                            browserUsdPerMinute,
                          })
                        }
                        onErrorChange={setBrowserUseBrowserPriceError}
                      />
                      <FieldError>{browserUseBrowserPriceError}</FieldError>
                    </Field>
                    <Field
                      controlId="browser-use-action-usd"
                      invalid={Boolean(browserUseActionPriceError)}
                    >
                      <FieldLabel>Action price USD</FieldLabel>
                      <NumberField
                        id="browser-use-action-usd"
                        min={0}
                        emptyValue={0}
                        value={browser.browserUseCloud.pricing.actionUsd}
                        onValueChange={(actionUsd) =>
                          setBrowserPricing(setDraft, 'browserUseCloud', {
                            actionUsd,
                          })
                        }
                        onErrorChange={setBrowserUseActionPriceError}
                      />
                      <FieldError>{browserUseActionPriceError}</FieldError>
                    </Field>
                  </>
                ) : null}
              </FieldGroup>
            </FieldSet>
          </>
        )}
      </div>

      {unsavedChangesDialog}
    </div>
  );
}
