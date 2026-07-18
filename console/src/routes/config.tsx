import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
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
import { Card } from '../components/card';
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
} from '../components/field';
import { Form, FormField, useForm } from '../components/form';
import { Trash } from '../components/icons';
import { Input } from '../components/input';
import { ManagedElsewhereBanner } from '../components/managed-elsewhere-banner';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { SecretRefPicker } from '../components/secret-ref-picker';
import { ADMIN_CONFIG_SECTION_OWNERS } from '../components/sidebar/navigation';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { ToggleGroup, ToggleGroupItem } from '../components/ui/toggle-group';
import { DEFAULT_VIEW_SWITCH_ITEMS } from '../components/view-switch';
import { useFormMutation } from '../hooks/use-form-mutation';
import { useUnsavedChangesGuard } from '../hooks/use-unsaved-changes-guard';
import { getErrorMessage } from '../lib/error-message';
import { findTopLevelJsonSection } from '../lib/json-cursor-section';
import styles from './config.module.css';

function serialize(config: AdminConfig): string {
  return JSON.stringify(config, null, 2);
}

type DraftSetter = Dispatch<SetStateAction<AdminConfig | null>>;

type BrowserConfig = NonNullable<AdminConfig['browser']>;
type BrowserProvider = BrowserConfig['provider'];
type BrowserObjectSection = Exclude<
  keyof BrowserConfig,
  'provider' | 'allowPrivateNetwork'
>;
type NavigationItem = NonNullable<AdminConfig['ui']>['navigation'][number];
const LOCAL_DOCKER_POOL_TENANT_ID = 'main';

const PROVIDER_OPTIONS: ReadonlyArray<{
  value: BrowserProvider;
  label: string;
}> = [
  { value: 'local', label: 'Local (Playwright)' },
  { value: 'camofox', label: 'Camoufox (anti-detection)' },
  { value: 'managed-cloud', label: 'Managed cloud (Docker pool)' },
  { value: 'browser-use-cloud', label: 'Browser Use cloud' },
  { value: 'mac-cua', label: 'Mac CUA (native browser)' },
];

const CONTAINER_MEMORY_PATTERN = /^\d+(?:\.\d+)?[kKmMgG]?$/;
const NAVIGATION_LABEL_MAX_LENGTH = 48;
const NAVIGATION_HREF_INPUT_PATTERN = '(?:/(?!/).*|https?://.+)';
const NAVIGATION_HREF_ERROR =
  'Use a local path starting with / or an http(s) URL.';
const NAVIGATION_IMAGE_INPUT_PATTERN = '(?:|/(?!/).*|https?://.+)';
const NAVIGATION_IMAGE_ERROR =
  'Use a local image path starting with / or an http(s) image URL.';

const NEW_NAVIGATION_ITEM: NavigationItem = {
  href: '',
  label: '',
};

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
    macCua: {
      browser: 'chrome',
      driverCommand: '',
      driverArgs: [],
      screenshotMode: 'som',
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
    macCua: {
      ...defaultBrowserConfig().macCua,
      ...(config.browser?.macCua ?? {}),
    },
  });
}

function navigationConfig(config: AdminConfig): NavigationItem[] {
  return Array.isArray(config.ui?.navigation)
    ? config.ui.navigation
    : DEFAULT_VIEW_SWITCH_ITEMS.map((item) => ({ ...item }));
}

function validateNavigationLabel(value: string): string | null {
  if (value.trim() === '') return 'Required.';
  return value.length > NAVIGATION_LABEL_MAX_LENGTH
    ? `Must be at most ${NAVIGATION_LABEL_MAX_LENGTH} characters.`
    : null;
}

function validateNavigationHref(value: string): string | null {
  const candidate = value.trim();
  if (candidate === '') return 'Required.';

  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//')) {
      return NAVIGATION_HREF_ERROR;
    }
    try {
      new URL(candidate, 'http://127.0.0.1');
      return null;
    } catch {
      return NAVIGATION_HREF_ERROR;
    }
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? null
      : NAVIGATION_HREF_ERROR;
  } catch {
    return NAVIGATION_HREF_ERROR;
  }
}

function validateNavigationImage(value: string | undefined): string | null {
  const candidate = (value ?? '').trim();
  if (candidate === '') return null;

  if (candidate.startsWith('/')) {
    if (candidate.startsWith('//')) {
      return NAVIGATION_IMAGE_ERROR;
    }
    try {
      new URL(candidate, 'http://127.0.0.1');
      return null;
    } catch {
      return NAVIGATION_IMAGE_ERROR;
    }
  }

  try {
    const parsed = new URL(candidate);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
      ? null
      : NAVIGATION_IMAGE_ERROR;
  } catch {
    return NAVIGATION_IMAGE_ERROR;
  }
}

function withBrowser(
  current: AdminConfig | null,
  updater: (browser: BrowserConfig) => BrowserConfig,
): AdminConfig | null {
  if (!current) return current;
  return { ...current, browser: updater(browserConfig(current)) };
}

function withNavigation(
  current: AdminConfig | null,
  updater: (navigation: NavigationItem[]) => NavigationItem[],
): AdminConfig | null {
  if (!current) return current;
  return {
    ...current,
    ui: {
      ...(current.ui ?? {}),
      navigation: updater(navigationConfig(current)),
    },
  };
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

function NavigationFields({
  items,
  setDraft,
}: {
  items: NavigationItem[];
  setDraft: DraftSetter;
}) {
  const nextRowKeyRef = useRef(0);
  const rowKeysRef = useRef<string[]>([]);
  const getRowKey = (index: number): string => {
    while (rowKeysRef.current.length <= index) {
      const nextKey = nextRowKeyRef.current;
      nextRowKeyRef.current += 1;
      rowKeysRef.current.push(`navigation-row-${nextKey}`);
    }
    return rowKeysRef.current[index];
  };

  const updateItem = (index: number, updates: Partial<NavigationItem>) => {
    setDraft((current) =>
      withNavigation(current, (navigation) =>
        navigation.map((item, currentIndex) =>
          currentIndex === index ? { ...item, ...updates } : item,
        ),
      ),
    );
  };

  const removeItem = (index: number) => {
    rowKeysRef.current.splice(index, 1);
    setDraft((current) =>
      withNavigation(current, (navigation) =>
        navigation.filter((_, currentIndex) => currentIndex !== index),
      ),
    );
  };

  const addItem = () => {
    const nextKey = nextRowKeyRef.current;
    nextRowKeyRef.current += 1;
    rowKeysRef.current.push(`navigation-row-${nextKey}`);
    setDraft((current) =>
      withNavigation(current, (navigation) => [
        ...navigation,
        { ...NEW_NAVIGATION_ITEM },
      ]),
    );
  };

  return (
    <Field>
      <FieldLabel>Navigation links</FieldLabel>
      <FieldDescription>
        Local paths like <code>/admin/channels</code> and HTTP(S) URLs are shown
        in the top navigation strip. Optional image paths or URLs render as the
        link icon.
      </FieldDescription>
      {items.length > 0 ? (
        <div className={styles.navigationList}>
          {items.map((item, index) => {
            const rowKey = getRowKey(index);
            return (
              <div className={styles.navigationRow} key={rowKey}>
                <Field
                  required
                  error={validateNavigationLabel(item.label)}
                  className={styles.navigationControl}
                >
                  <Input
                    aria-label={`Navigation item ${index + 1} label`}
                    value={item.label}
                    placeholder="Link text"
                    maxLength={NAVIGATION_LABEL_MAX_LENGTH}
                    onChange={(event) =>
                      updateItem(index, {
                        icon: undefined,
                        label: event.target.value,
                      })
                    }
                  />
                  <FieldError />
                </Field>
                <Field
                  required
                  error={validateNavigationHref(item.href)}
                  className={styles.navigationControl}
                >
                  <Input
                    aria-label={`Navigation item ${index + 1} href`}
                    value={item.href}
                    placeholder="/admin/channels or https://hybridclaw.io"
                    pattern={NAVIGATION_HREF_INPUT_PATTERN}
                    title={NAVIGATION_HREF_ERROR}
                    onChange={(event) =>
                      updateItem(index, {
                        href: event.target.value,
                        icon: undefined,
                      })
                    }
                  />
                  <FieldError />
                </Field>
                <Field
                  error={validateNavigationImage(item.image)}
                  className={styles.navigationControl}
                >
                  <Input
                    aria-label={`Navigation item ${index + 1} image`}
                    value={item.image ?? ''}
                    placeholder="/icons/hybridai.png"
                    pattern={NAVIGATION_IMAGE_INPUT_PATTERN}
                    title={NAVIGATION_IMAGE_ERROR}
                    onChange={(event) =>
                      updateItem(index, {
                        image: event.target.value.trim()
                          ? event.target.value
                          : undefined,
                      })
                    }
                  />
                  <FieldError />
                </Field>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove navigation item ${index + 1}`}
                  onClick={() => removeItem(index)}
                >
                  <Trash width={15} height={15} />
                </Button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="muted-copy">No navigation links configured.</p>
      )}
      <div className="button-row">
        <Button type="button" variant="ghost" onClick={addItem}>
          Add link
        </Button>
      </div>
    </Field>
  );
}

export function ConfigPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [viewMode, setViewMode] = useState<'form' | 'json'>('form');
  const [rawJson, setRawJson] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [jsonCursorSection, setJsonCursorSection] = useState<string | null>(
    null,
  );

  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });

  const form = useForm<AdminConfig>({ source: configQuery.data?.config });
  const {
    draft,
    setDraft,
    isDirty: formIsDirty,
    discard: discardDraft,
    commit: commitDraft,
  } = form;

  const savedSerialized = useMemo(
    () => (configQuery.data ? serialize(configQuery.data.config) : ''),
    [configQuery.data],
  );

  // Seed the JSON editor once, when the config first arrives. Keyed on a ref
  // rather than `rawJson === ''` — the latter re-fired the moment the user
  // cleared the textarea, snapping the saved config back so it couldn't be
  // emptied. Entering JSON mode and a successful save refresh `rawJson` anyway.
  const didHydrateRawJsonRef = useRef(false);
  if (!didHydrateRawJsonRef.current && savedSerialized !== '') {
    didHydrateRawJsonRef.current = true;
    setRawJson(savedSerialized);
  }

  const isDirty =
    viewMode === 'json' ? rawJson !== savedSerialized : formIsDirty;

  const saveMutation = useFormMutation({
    mutationFn: (nextConfig: AdminConfig) => saveConfig(auth.token, nextConfig),
    onSuccess: (payload) => {
      // Update the source query cache so `isDirty` (draft vs. source) clears
      // after a save. Without this the page stays "dirty" — `commitDraft`
      // only moves the draft to the saved value, while `source` keeps the
      // originally-fetched config, so Discard would revert the just-saved
      // edits. Mirrors the pattern in channels.tsx.
      queryClient.setQueryData(['config', auth.token], payload);
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

  const handleRawJsonChange = useCallback(
    (next: string, cursorOffset: number) => {
      setRawJson(next);
      setJsonCursorSection(findTopLevelJsonSection(next, cursorOffset));
      try {
        JSON.parse(next);
        setJsonError(null);
      } catch (error) {
        setJsonError(getErrorMessage(error));
      }
    },
    [],
  );

  const { dialog: unsavedChangesDialog } = useUnsavedChangesGuard({
    isDirty,
    description:
      'You have unsaved edits to the runtime config. Leaving this page will discard them.',
  });

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
  const navigation = navigationConfig(draft);

  const handleViewModeChange = (next: string) => {
    const target = next === 'json' ? 'json' : 'form';
    if (target === viewMode) return;
    if (target === 'form') {
      try {
        const parsed = JSON.parse(rawJson) as AdminConfig;
        setDraft(parsed);
        setJsonError(null);
        setJsonCursorSection(null);
        setViewMode('form');
      } catch (error) {
        setJsonError(getErrorMessage(error));
      }
      return;
    }
    setRawJson(serialize(draft));
    setJsonError(null);
    setJsonCursorSection(null);
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

  const saveDisabled =
    saveMutation.isPending ||
    (viewMode === 'json' ? Boolean(jsonError) : !form.isValid);
  const jsonSectionOwner = jsonCursorSection
    ? ADMIN_CONFIG_SECTION_OWNERS[jsonCursorSection]
    : undefined;

  return (
    <Form form={form} className={styles.page} onSubmit={save}>
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
                type="submit"
                loading={saveMutation.isPending}
                disabled={saveDisabled}
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
          <>
            {jsonSectionOwner ? (
              <ManagedElsewhereBanner owner={jsonSectionOwner} />
            ) : null}
            <Field className={styles.jsonField} invalid={Boolean(jsonError)}>
              <FieldLabel>config.json</FieldLabel>
              <Textarea
                className={`code-editor ${styles.jsonEditor}`}
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                value={rawJson}
                onChange={(event) =>
                  handleRawJsonChange(
                    event.target.value,
                    event.target.selectionStart,
                  )
                }
                onSelect={(event) =>
                  setJsonCursorSection(
                    findTopLevelJsonSection(
                      rawJson,
                      event.currentTarget.selectionStart,
                    ),
                  )
                }
              />
              <FieldError>{jsonError}</FieldError>
            </Field>
          </>
        ) : (
          <>
            <Card className={styles.sectionCard}>
              <FieldSet>
                <FieldLegend>Operations</FieldLegend>
                <FieldDescription className={styles.sectionDescription}>
                  Gateway listener and public URLs.
                </FieldDescription>
                <FieldGroup>
                  <FormField
                    name="ops.healthHost"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Health host</FieldLabel>
                        <Input {...field} />
                        <FieldDescription>
                          Interface the gateway binds to. Use{' '}
                          <code>127.0.0.1</code> for loopback-only.
                        </FieldDescription>
                      </Field>
                    )}
                  />
                  <FormField
                    name="ops.healthPort"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Health port</FieldLabel>
                        <NumberField
                          integer
                          min={1}
                          max={65535}
                          value={field.value as number}
                          onValueChange={field.onChange}
                        />
                        <FieldError />
                      </Field>
                    )}
                  />
                  <FormField
                    name="ops.gatewayBaseUrl"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Gateway public URL</FieldLabel>
                        <Input {...field} />
                        <FieldDescription>
                          Externally reachable URL used for webhooks and public
                          callbacks.
                        </FieldDescription>
                      </Field>
                    )}
                  />
                  <FormField
                    name="ops.gatewayInternalBaseUrl"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Gateway internal URL</FieldLabel>
                        <Input {...field} />
                        <FieldDescription>
                          Local URL used by TUI, containers, and host-side
                          gateway clients.
                        </FieldDescription>
                      </Field>
                    )}
                  />
                </FieldGroup>
              </FieldSet>
            </Card>

            <Card className={styles.sectionCard}>
              <FieldSet>
                <FieldLegend>Navigation</FieldLegend>
                <FieldDescription className={styles.sectionDescription}>
                  Top-level links shown in the console navigation strip.
                </FieldDescription>
                <FieldGroup>
                  <NavigationFields items={navigation} setDraft={setDraft} />
                </FieldGroup>
              </FieldSet>
            </Card>

            <Card className={styles.sectionCard}>
              <FieldSet>
                <FieldLegend>Security</FieldLegend>
                <FieldDescription className={styles.sectionDescription}>
                  Sensitive-content guards applied to agent output.
                </FieldDescription>
                <FieldGroup>
                  <FormField
                    name="security.confidentialRedactionEnabled"
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <Switch
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                        <FieldContent>
                          <FieldLabel>Confidential leak guard</FieldLabel>
                          <FieldDescription>
                            Redact secrets and sensitive patterns before they
                            leave the agent.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    )}
                  />
                </FieldGroup>
              </FieldSet>
            </Card>

            <Card className={styles.sectionCard}>
              <FieldSet>
                <FieldLegend>HybridAI</FieldLegend>
                <FieldDescription className={styles.sectionDescription}>
                  HybridAI provider defaults.
                </FieldDescription>
                <FieldGroup>
                  <FormField
                    name="hybridai.baseUrl"
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Base URL</FieldLabel>
                        <Input type="url" {...field} />
                      </Field>
                    )}
                  />
                  <FormField
                    name="hybridai.enableRag"
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <Switch
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                        <FieldContent>
                          <FieldLabel>RAG default</FieldLabel>
                          <FieldDescription>
                            Enable retrieval augmentation by default for new
                            conversations.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    )}
                  />
                </FieldGroup>
              </FieldSet>
            </Card>

            <Card className={styles.sectionCard}>
              <FieldSet>
                <FieldLegend>Container</FieldLegend>
                <FieldDescription className={styles.sectionDescription}>
                  Sandboxed container runtime for tool execution.
                </FieldDescription>
                <FieldGroup>
                  <FormField
                    name="container.memory"
                    rules={[
                      required(),
                      pattern(
                        CONTAINER_MEMORY_PATTERN,
                        'Use a number with optional k, m, or g suffix.',
                      ),
                    ]}
                    render={({ field }) => (
                      <Field>
                        <FieldLabel>Memory</FieldLabel>
                        <Input {...field} placeholder="1024m" />
                        <FieldDescription>
                          Docker memory limit. e.g. <code>512m</code>,{' '}
                          <code>1g</code>, <code>2048m</code>.
                        </FieldDescription>
                        <FieldError />
                      </Field>
                    )}
                  />
                  <FormField
                    name="container.persistBashState"
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <Switch
                          checked={Boolean(field.value)}
                          onCheckedChange={field.onChange}
                        />
                        <FieldContent>
                          <FieldLabel>Persistent bash state</FieldLabel>
                          <FieldDescription>
                            Reuse the same shell across tool calls so cwd, env,
                            and aliases survive.
                          </FieldDescription>
                        </FieldContent>
                      </Field>
                    )}
                  />
                </FieldGroup>
              </FieldSet>
            </Card>

            <Card className={styles.sectionCard}>
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

                  <Field orientation="horizontal">
                    <Switch
                      checked={browser.allowPrivateNetwork}
                      onCheckedChange={(allowPrivateNetwork) =>
                        setDraft((current) =>
                          withBrowser(current, (b) => ({
                            ...b,
                            allowPrivateNetwork,
                          })),
                        )
                      }
                    />
                    <FieldContent>
                      <FieldLabel>Allow private network navigation</FieldLabel>
                      <FieldDescription>
                        Allow the browser to navigate to private and loopback
                        network addresses.
                      </FieldDescription>
                    </FieldContent>
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
                            className={browserPoolStatusClass(
                              browserPoolHealth,
                            )}
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
                            onClick={() =>
                              void browserPoolHealthQuery.refetch()
                            }
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
                          <FieldDescription
                            className={styles.poolStatusPending}
                          >
                            Pending save — status above reflects the previously
                            saved provider ({savedBrowserProvider}). Save
                            changes to refresh.
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
                        <FieldLabel>Pool token secret</FieldLabel>
                        <SecretRefPicker
                          value={managedPoolTokenId}
                          placeholder="MANAGED_BROWSER_POOL_TOKEN"
                          onValueChange={(id) => {
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
                        <Link
                          to="/admin/network-policy"
                          className="ghost-button"
                        >
                          Manage network policy
                        </Link>
                      </div>
                      <Field controlId="managed-cloud-action-usd">
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
                        />
                        <FieldError />
                      </Field>
                    </>
                  ) : null}

                  {browser.provider === 'browser-use-cloud' ? (
                    <>
                      <Field>
                        <FieldLabel>API key secret</FieldLabel>
                        <SecretRefPicker
                          value={browserUseApiKeyId}
                          placeholder="BROWSER_USE_API_KEY"
                          onValueChange={(id) => {
                            setBrowserSection(setDraft, 'browserUseCloud', {
                              apiKeyRef: id
                                ? { source: 'store', id }
                                : undefined,
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
                      <Field controlId="browser-use-browser-usd">
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
                        />
                        <FieldError />
                      </Field>
                      <Field controlId="browser-use-action-usd">
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
                        />
                        <FieldError />
                      </Field>
                    </>
                  ) : null}
                  {browser.provider === 'mac-cua' ? (
                    <>
                      <Field>
                        <FieldLabel>Native browser</FieldLabel>
                        <NativeSelect
                          value={browser.macCua.browser}
                          onChange={(event) =>
                            setDraft((current) =>
                              withBrowser(current, (b) => ({
                                ...b,
                                macCua: {
                                  ...b.macCua,
                                  browser: event.target
                                    .value as BrowserConfig['macCua']['browser'],
                                },
                              })),
                            )
                          }
                        >
                          <NativeSelectOption value="safari">
                            safari
                          </NativeSelectOption>
                          <NativeSelectOption value="chrome">
                            chrome
                          </NativeSelectOption>
                          <NativeSelectOption value="firefox">
                            firefox
                          </NativeSelectOption>
                          <NativeSelectOption value="brave">
                            brave
                          </NativeSelectOption>
                          <NativeSelectOption value="arc">
                            arc
                          </NativeSelectOption>
                        </NativeSelect>
                      </Field>
                      <Field>
                        <FieldLabel>Driver command</FieldLabel>
                        <Input
                          value={browser.macCua.driverCommand}
                          placeholder="cua-driver"
                          onChange={(event) =>
                            setDraft((current) =>
                              withBrowser(current, (b) => ({
                                ...b,
                                macCua: {
                                  ...b.macCua,
                                  driverCommand: event.target.value,
                                },
                              })),
                            )
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Driver args</FieldLabel>
                        <Input
                          value={browser.macCua.driverArgs.join(' ')}
                          placeholder="mcp --no-daemon-relaunch"
                          onChange={(event) =>
                            setDraft((current) =>
                              withBrowser(current, (b) => ({
                                ...b,
                                macCua: {
                                  ...b.macCua,
                                  driverArgs: event.target.value
                                    .split(/\s+/u)
                                    .map((part) => part.trim())
                                    .filter(Boolean),
                                },
                              })),
                            )
                          }
                        />
                      </Field>
                      <Field>
                        <FieldLabel>Screenshot mode</FieldLabel>
                        <NativeSelect
                          value={browser.macCua.screenshotMode}
                          onChange={(event) =>
                            setDraft((current) =>
                              withBrowser(current, (b) => ({
                                ...b,
                                macCua: {
                                  ...b.macCua,
                                  screenshotMode: event.target
                                    .value as BrowserConfig['macCua']['screenshotMode'],
                                },
                              })),
                            )
                          }
                        >
                          <NativeSelectOption value="som">
                            som
                          </NativeSelectOption>
                          <NativeSelectOption value="vision">
                            vision
                          </NativeSelectOption>
                          <NativeSelectOption value="ax">ax</NativeSelectOption>
                        </NativeSelect>
                      </Field>
                    </>
                  ) : null}
                </FieldGroup>
              </FieldSet>
            </Card>
          </>
        )}
      </div>

      {unsavedChangesDialog}
    </Form>
  );
}
