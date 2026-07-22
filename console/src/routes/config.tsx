import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '../components/field';
import { Form, useForm } from '../components/form';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { SecretRefPicker } from '../components/secret-ref-picker';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { PageHeader } from '../components/ui';
import { useFormMutation } from '../hooks/use-form-mutation';
import { useUnsavedChangesGuard } from '../hooks/use-unsaved-changes-guard';
import {
  isSettingValuePresent,
  SETTINGS_REGISTRY_SECTIONS,
  type SettingsRegistryEntry,
  type SettingsRegistrySection,
  settingAnchor,
  settingKindForValue,
  settingsSearchText,
  settingValue,
  withSettingValue,
} from '../lib/settings-registry';
import styles from './config.module.css';

const ENUM_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = {
  'container.sandboxMode': ['container', 'host'],
  'browser.provider': [
    'local',
    'camofox',
    'managed-cloud',
    'browser-use-cloud',
    'mac-cua',
  ],
  'deployment.mode': ['local', 'cloud'],
  'memory.queryMode': ['hybrid', 'semantic', 'keyword'],
  'sessionReset.defaultPolicy.mode': ['off', 'daily', 'idle', 'both'],
  'sessionRouting.dmScope': [
    'main',
    'per-peer',
    'per-channel-peer',
    'per-account-channel-peer',
  ],
  'web.search.provider': ['auto', 'brave', 'perplexity', 'searxng', 'tavily'],
};

const SENSITIVE_SETTING_OWNERS: Readonly<Record<string, string>> = {
  'ops.webApiToken': '/admin/gateway',
  'ops.gatewayApiToken': '/admin/gateway',
};

function initialSearchParam(name: string): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get(name)?.trim() ?? '';
}

function setSettingsLocation(section: string, query: string): void {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  url.searchParams.set('section', section);
  if (query.trim()) url.searchParams.set('q', query.trim());
  else url.searchParams.delete('q');
  window.history.replaceState(window.history.state, '', url);
}

function isStoredSecretRef(
  value: unknown,
): value is { source: 'store'; id: string } {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return record.source === 'store' && typeof record.id === 'string';
}

function serializeStructuredValue(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function StructuredSettingField(props: {
  entry: SettingsRegistryEntry;
  value: unknown;
  onValueChange: (value: unknown) => void;
}) {
  const [raw, setRaw] = useState(() => serializeStructuredValue(props.value));
  const [error, setError] = useState<string | null>(null);

  return (
    <Field
      id={settingAnchor(props.entry.path)}
      error={error}
      className={styles.settingField}
    >
      <FieldLabel>{props.entry.label}</FieldLabel>
      <Textarea
        className={styles.inlineJsonEditor}
        aria-label={props.entry.label}
        value={raw}
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setRaw(next);
          try {
            props.onValueChange(JSON.parse(next));
            setError(null);
          } catch (parseError) {
            setError(
              parseError instanceof Error
                ? parseError.message
                : 'Enter valid JSON.',
            );
          }
        }}
      />
      <FieldDescription>{props.entry.description}</FieldDescription>
      <FieldError>{error}</FieldError>
    </Field>
  );
}

function OwnedSettingRow(props: { entry: SettingsRegistryEntry }) {
  const owner = props.entry.owner;
  if (!owner) return null;
  return (
    <div id={settingAnchor(props.entry.path)} className={styles.ownedSetting}>
      <div>
        <strong>{props.entry.label}</strong>
        <span>{props.entry.path}</span>
      </div>
      <Link to={owner.to}>Open {owner.label} →</Link>
    </div>
  );
}

function SettingField(props: {
  entry: SettingsRegistryEntry;
  value: unknown;
  resetSeq: number;
  onValueChange: (value: unknown) => void;
}) {
  if (props.entry.owner) return <OwnedSettingRow entry={props.entry} />;

  if (SENSITIVE_SETTING_OWNERS[props.entry.path]) {
    return (
      <div id={settingAnchor(props.entry.path)} className={styles.ownedSetting}>
        <div>
          <strong>{props.entry.label}</strong>
          <span>Credential values are managed outside runtime config.</span>
        </div>
        <Link to={SENSITIVE_SETTING_OWNERS[props.entry.path]}>
          Open Gateway →
        </Link>
      </div>
    );
  }

  if (props.entry.path === 'version') {
    return (
      <Field
        id={settingAnchor(props.entry.path)}
        className={styles.settingField}
      >
        <FieldLabel>{props.entry.label}</FieldLabel>
        <Input value={String(props.value ?? '')} readOnly />
        <FieldDescription>
          Managed by runtime schema migrations.
        </FieldDescription>
      </Field>
    );
  }

  if (isStoredSecretRef(props.value)) {
    return (
      <Field
        id={settingAnchor(props.entry.path)}
        className={styles.settingField}
      >
        <FieldLabel>{props.entry.label}</FieldLabel>
        <SecretRefPicker
          value={props.value.id}
          onValueChange={(id) =>
            props.onValueChange(id ? { source: 'store', id } : undefined)
          }
        />
        <FieldDescription>{props.entry.description}</FieldDescription>
      </Field>
    );
  }

  const options = ENUM_OPTIONS[props.entry.path];
  if (options) {
    return (
      <Field
        id={settingAnchor(props.entry.path)}
        className={styles.settingField}
      >
        <FieldLabel>{props.entry.label}</FieldLabel>
        <NativeSelect
          value={String(props.value ?? '')}
          onChange={(event) => props.onValueChange(event.target.value)}
        >
          {options.map((option) => (
            <NativeSelectOption key={option} value={option}>
              {option}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <FieldDescription>{props.entry.description}</FieldDescription>
      </Field>
    );
  }

  const kind = settingKindForValue(props.value, props.entry.kind);
  if (kind === 'boolean') {
    return (
      <Field
        id={settingAnchor(props.entry.path)}
        className={styles.settingField}
        orientation="horizontal"
      >
        <Switch
          aria-label={props.entry.label}
          checked={Boolean(props.value)}
          onCheckedChange={props.onValueChange}
        />
        <FieldContent>
          <FieldLabel>{props.entry.label}</FieldLabel>
          <FieldDescription>{props.entry.description}</FieldDescription>
        </FieldContent>
      </Field>
    );
  }

  if (kind === 'number') {
    return (
      <Field
        id={settingAnchor(props.entry.path)}
        className={styles.settingField}
      >
        <FieldLabel>{props.entry.label}</FieldLabel>
        <NumberField
          value={Number(props.value ?? 0)}
          integer={Number.isInteger(props.value)}
          onValueChange={props.onValueChange}
        />
        <FieldDescription>{props.entry.description}</FieldDescription>
        <FieldError />
      </Field>
    );
  }

  if (kind === 'list' || kind === 'object') {
    return (
      <StructuredSettingField
        key={`${props.entry.path}-${props.resetSeq}`}
        entry={props.entry}
        value={props.value}
        onValueChange={props.onValueChange}
      />
    );
  }

  return (
    <Field id={settingAnchor(props.entry.path)} className={styles.settingField}>
      <FieldLabel>{props.entry.label}</FieldLabel>
      <Input
        value={String(props.value ?? '')}
        onChange={(event) => props.onValueChange(event.target.value)}
      />
      <FieldDescription>{props.entry.description}</FieldDescription>
    </Field>
  );
}

function SettingsSectionCard(props: {
  section: SettingsRegistrySection;
  config: AdminConfig;
  resetSeq: number;
  entries?: ReadonlyArray<SettingsRegistryEntry>;
  onValueChange: (path: string, value: unknown) => void;
}) {
  const entries = (props.entries ?? props.section.entries).filter((entry) =>
    isSettingValuePresent(props.config, entry),
  );

  return (
    <Card
      id={`settings-section-${props.section.id}`}
      className={styles.sectionCard}
    >
      <CardHeader>
        <CardTitle>{props.section.label}</CardTitle>
        <CardDescription>{props.section.description}</CardDescription>
      </CardHeader>
      <CardContent className={styles.settingFields}>
        {props.section.owner ? (
          <div className={styles.sectionOwner}>
            <span>These settings have a dedicated management surface.</span>
            <Link to={props.section.owner.to}>
              Open {props.section.owner.label} →
            </Link>
          </div>
        ) : null}
        {props.section.owner
          ? null
          : entries.map((entry) => (
              <SettingField
                key={entry.path}
                entry={entry}
                value={settingValue(props.config, entry.path)}
                resetSeq={props.resetSeq}
                onValueChange={(value) =>
                  props.onValueChange(entry.path, value)
                }
              />
            ))}
        {entries.length === 0 && !props.section.owner ? (
          <div className="empty-state">No settings in this section.</div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ConfigPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState(() => initialSearchParam('q'));
  const [selectedSection, setSelectedSection] = useState(
    () => initialSearchParam('section') || 'ops',
  );
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const form = useForm<AdminConfig>({ source: configQuery.data?.config });
  const { draft, setDraft, isDirty, discard, commit } = form;

  const visibleSections = useMemo(
    () =>
      SETTINGS_REGISTRY_SECTIONS.filter((section) =>
        section.entries.some(
          (entry) => draft && isSettingValuePresent(draft, entry),
        ),
      ),
    [draft],
  );
  const activeSection =
    visibleSections.find((section) => section.id === selectedSection) ??
    visibleSections[0];
  const needle = search.trim().toLowerCase();
  const searchResults = needle
    ? visibleSections
        .map((section) => ({
          section,
          entries: section.entries.filter(
            (entry) =>
              draft &&
              isSettingValuePresent(draft, entry) &&
              settingsSearchText(entry).includes(needle),
          ),
        }))
        .filter((result) => result.entries.length > 0)
    : [];

  const saveMutation = useFormMutation({
    mutationFn: (config: AdminConfig) => saveConfig(auth.token, config),
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      commit(payload.config);
      toast.success('Runtime config saved.');
    },
    onError: (error) => toast.error('Save failed', error.message),
  });
  const { dialog: unsavedChangesDialog } = useUnsavedChangesGuard({
    isDirty,
    description:
      'You have unsaved edits to the runtime config. Leaving this page will discard them.',
  });

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading runtime config…</div>;
  }
  if (!draft || !configQuery.data || !activeSection) {
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

  const updateSetting = (path: string, value: unknown) => {
    setDraft((current) =>
      current ? withSettingValue(current, path, value) : current,
    );
  };

  return (
    <Form
      form={form}
      className={styles.page}
      onSubmit={() => saveMutation.mutate(draft)}
    >
      <PageHeader
        description={
          <>
            <span className={styles.path}>{configQuery.data.path}</span>
            <span className={styles.statusInline}>
              {isDirty ? 'Unsaved changes' : 'Saved'}
            </span>
          </>
        }
        actions={
          <>
            <Input
              className={styles.settingsSearch}
              value={search}
              onChange={(event) => {
                const next = event.target.value;
                setSearch(next);
                setSettingsLocation(activeSection.id, next);
              }}
              placeholder="Search settings…"
              aria-label="Search settings"
            />
            {isDirty ? (
              <Button type="button" variant="ghost" onClick={discard}>
                Discard
              </Button>
            ) : null}
            {isDirty || !form.isValid || saveMutation.isPending ? (
              <Button
                type="submit"
                loading={saveMutation.isPending}
                disabled={saveMutation.isPending || !form.isValid}
              >
                {saveMutation.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            ) : null}
          </>
        }
      />

      <div className={styles.settingsLayout}>
        <nav className={styles.sectionRail} aria-label="Settings sections">
          {visibleSections.map((section) => (
            <button
              key={section.id}
              type="button"
              className={
                !needle && section.id === activeSection.id
                  ? styles.sectionRailActive
                  : undefined
              }
              onClick={() => {
                setSelectedSection(section.id);
                setSearch('');
                setSettingsLocation(section.id, '');
              }}
            >
              <span>{section.label}</span>
              {section.owner ? <small>↗</small> : null}
            </button>
          ))}
        </nav>

        <div className={styles.sectionContent}>
          {needle ? (
            searchResults.length > 0 ? (
              searchResults.map((result) => (
                <SettingsSectionCard
                  key={result.section.id}
                  section={result.section}
                  entries={result.entries}
                  config={draft}
                  resetSeq={form.resetSeq}
                  onValueChange={updateSetting}
                />
              ))
            ) : (
              <div className="empty-state">
                No settings match “{search.trim()}”.
              </div>
            )
          ) : (
            <SettingsSectionCard
              section={activeSection}
              config={draft}
              resetSeq={form.resetSeq}
              onValueChange={updateSetting}
            />
          )}
        </div>
      </div>

      {unsavedChangesDialog}
    </Form>
  );
}
