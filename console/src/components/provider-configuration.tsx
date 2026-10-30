import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fromGatewayModelProviderKey,
  GATEWAY_MODEL_PROVIDER_KEYS,
  type GatewayModelProviderKey,
} from '../../../src/gateway/model-provider-keys';
import { isLocalBackendType } from '../../../src/providers/provider-ids';
import {
  PROVIDER_META,
  type ProviderMeta,
} from '../../../src/providers/provider-meta';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig } from '../api/types';
import { useAuth } from '../auth';
import { useFormMutation } from '../hooks/use-form-mutation';
import { settingValue, withSettingValue } from '../lib/settings-registry';
import { Button } from './button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from './card';
import { Field, FieldContent, FieldDescription, FieldLabel } from './field';
import { Form, useForm } from './form';
import { Input } from './input';
import { NativeSelect, NativeSelectOption } from './native-select';
import styles from './provider-configuration.module.css';
import type { ProviderEntry } from './provider-health';
import { CanonicalSecretStatus, SecretRefPicker } from './secret-ref-picker';
import { Switch } from './switch';
import { useToast } from './toast';

interface ProviderDescriptor {
  id: string;
  label: string;
  sectionPath: string;
  enabledPath?: string;
  baseUrlPath?: string;
  secretName?: string;
  secretPath?: string;
  select?: {
    path: string;
    label: string;
    options: ReadonlyArray<string>;
  };
}

function describeProvider(key: GatewayModelProviderKey): ProviderDescriptor {
  const id = fromGatewayModelProviderKey(key);
  const meta: ProviderMeta = PROVIDER_META[id];
  const sectionPath = isLocalBackendType(id) ? `local.backends.${id}` : key;
  return {
    id: key,
    label: meta.label,
    sectionPath,
    ...(id === 'hybridai' || id === 'openai-codex'
      ? {}
      : { enabledPath: `${sectionPath}.enabled` }),
    baseUrlPath: `${sectionPath}.baseUrl`,
    ...(meta.secretKey ? { secretName: meta.secretKey } : {}),
    ...(id === 'vllm' ? { secretPath: `${sectionPath}.apiKey` } : {}),
    ...(id === 'anthropic'
      ? {
          select: {
            path: 'anthropic.method',
            label: 'Authentication method',
            options: ['api-key', 'claude-cli'],
          },
        }
      : {}),
  };
}

const PROVIDERS: ReadonlyArray<ProviderDescriptor> =
  GATEWAY_MODEL_PROVIDER_KEYS.map(describeProvider);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function secretRefId(value: unknown, fallback: string): string {
  return isRecord(value) &&
    value.source === 'store' &&
    typeof value.id === 'string'
    ? value.id
    : fallback;
}

function ProviderConfigCard(props: {
  descriptor: ProviderDescriptor;
  draft: AdminConfig;
  status?: ProviderEntry;
  onSettingChange: (path: string, value: unknown) => void;
}) {
  const descriptor = props.descriptor;
  const enabled = descriptor.enabledPath
    ? Boolean(settingValue(props.draft, descriptor.enabledPath))
    : true;
  const statusText = props.status?.reachable
    ? props.status.detail || 'Healthy'
    : props.status?.detail ||
      props.status?.error ||
      (enabled ? 'Unavailable' : 'Disabled');

  return (
    <Card className={styles.providerCard}>
      <CardHeader>
        <div>
          <CardTitle>{descriptor.label}</CardTitle>
          <CardDescription>{statusText}</CardDescription>
        </div>
        <span
          className={
            props.status?.reachable ? styles.statusHealthy : styles.statusMuted
          }
        >
          {props.status?.reachable
            ? 'Healthy'
            : enabled
              ? 'Needs attention'
              : 'Off'}
        </span>
      </CardHeader>
      <CardContent className={styles.providerFields}>
        {descriptor.enabledPath ? (
          <Field orientation="horizontal">
            <Switch
              aria-label={`Enable ${descriptor.label}`}
              checked={enabled}
              onCheckedChange={(checked) =>
                props.onSettingChange(descriptor.enabledPath as string, checked)
              }
            />
            <FieldContent>
              <FieldLabel>Enabled</FieldLabel>
              <FieldDescription>
                Include this provider in model discovery and routing.
              </FieldDescription>
            </FieldContent>
          </Field>
        ) : null}

        {descriptor.baseUrlPath ? (
          <Field>
            <FieldLabel>Base URL</FieldLabel>
            <Input
              aria-label={`${descriptor.label} base URL`}
              value={String(
                settingValue(props.draft, descriptor.baseUrlPath) ?? '',
              )}
              onChange={(event) =>
                props.onSettingChange(
                  descriptor.baseUrlPath as string,
                  event.target.value,
                )
              }
            />
          </Field>
        ) : null}

        {descriptor.secretName ? (
          descriptor.secretPath ? (
            <Field>
              <FieldLabel>API key credential</FieldLabel>
              <SecretRefPicker
                value={secretRefId(
                  settingValue(props.draft, descriptor.secretPath),
                  descriptor.secretName,
                )}
                onValueChange={(id) =>
                  props.onSettingChange(
                    descriptor.secretPath as string,
                    id ? { source: 'store', id } : '',
                  )
                }
              />
            </Field>
          ) : (
            <div className={styles.providerCredential}>
              <span className={styles.providerCredentialLabel}>
                API key credential
              </span>
              <CanonicalSecretStatus
                name={descriptor.secretName}
                providerReachable={props.status?.reachable}
              />
            </div>
          )
        ) : null}

        {descriptor.select ? (
          <Field>
            <FieldLabel>{descriptor.select.label}</FieldLabel>
            <NativeSelect
              value={String(
                settingValue(props.draft, descriptor.select.path) ?? '',
              )}
              onChange={(event) =>
                props.onSettingChange(
                  descriptor.select?.path as string,
                  event.target.value,
                )
              }
            >
              {descriptor.select.options.map((option) => (
                <NativeSelectOption key={option} value={option}>
                  {option}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function ProviderConfiguration(props: {
  providerId: string;
  status?: ProviderEntry;
}) {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const form = useForm<AdminConfig>({ source: configQuery.data?.config });
  const { draft, setDraft, isDirty, discard, commit } = form;
  const saveMutation = useFormMutation({
    mutationFn: (config: AdminConfig) => saveConfig(auth.token, config),
    onSuccess: (payload) => {
      queryClient.setQueryData(['config', auth.token], payload);
      commit(payload.config);
      void queryClient.invalidateQueries({ queryKey: ['models', auth.token] });
      toast.success('Provider configuration saved.');
    },
    onError: (error) => toast.error('Provider save failed', error.message),
  });

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading provider configuration…</div>;
  }
  if (!draft) return null;

  const descriptor = PROVIDERS.find(
    (provider) =>
      provider.id === props.providerId &&
      settingValue(draft, provider.sectionPath) !== undefined,
  );

  if (!descriptor) {
    return (
      <div className="empty-state">
        No editable configuration is available for this provider.
      </div>
    );
  }

  return (
    <Form
      form={form}
      className={styles.configuration}
      onSubmit={() => saveMutation.mutate(draft)}
    >
      <div className={styles.configurationHeader}>
        <h2>Provider configuration</h2>
        <div className="button-row">
          {isDirty ? (
            <Button type="button" variant="ghost" onClick={discard}>
              Discard
            </Button>
          ) : null}
          {isDirty || saveMutation.isPending ? (
            <Button type="submit" loading={saveMutation.isPending}>
              {saveMutation.isPending ? 'Saving…' : 'Save providers'}
            </Button>
          ) : null}
        </div>
      </div>
      <ProviderConfigCard
        descriptor={descriptor}
        draft={draft}
        status={props.status}
        onSettingChange={(path, value) =>
          setDraft((current) =>
            current ? withSettingValue(current, path, value) : current,
          )
        }
      />
      <div className={styles.credentialsLink}>
        <a href="/admin/credentials">Manage all credentials →</a>
      </div>
    </Form>
  );
}
