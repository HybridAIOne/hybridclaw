import { useQuery, useQueryClient } from '@tanstack/react-query';
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
import { SecretRefPicker } from './secret-ref-picker';
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

const PROVIDERS: ReadonlyArray<ProviderDescriptor> = [
  {
    id: 'hybridai',
    label: 'HybridAI',
    sectionPath: 'hybridai',
    baseUrlPath: 'hybridai.baseUrl',
    secretName: 'HYBRIDAI_API_KEY',
  },
  {
    id: 'codex',
    label: 'Codex',
    sectionPath: 'codex',
    baseUrlPath: 'codex.baseUrl',
    select: {
      path: 'codex.turnRuntime',
      label: 'Turn runtime',
      options: ['hybridclaw', 'codex-cli'],
    },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    sectionPath: 'openai',
    enabledPath: 'openai.enabled',
    baseUrlPath: 'openai.baseUrl',
    secretName: 'OPENAI_API_KEY',
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    sectionPath: 'anthropic',
    enabledPath: 'anthropic.enabled',
    baseUrlPath: 'anthropic.baseUrl',
    secretName: 'ANTHROPIC_API_KEY',
    select: {
      path: 'anthropic.method',
      label: 'Authentication method',
      options: ['api-key', 'claude-cli'],
    },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    sectionPath: 'openrouter',
    enabledPath: 'openrouter.enabled',
    baseUrlPath: 'openrouter.baseUrl',
    secretName: 'OPENROUTER_API_KEY',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    sectionPath: 'mistral',
    enabledPath: 'mistral.enabled',
    baseUrlPath: 'mistral.baseUrl',
    secretName: 'MISTRAL_API_KEY',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    sectionPath: 'huggingface',
    enabledPath: 'huggingface.enabled',
    baseUrlPath: 'huggingface.baseUrl',
    secretName: 'HF_TOKEN',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    sectionPath: 'gemini',
    enabledPath: 'gemini.enabled',
    baseUrlPath: 'gemini.baseUrl',
    secretName: 'GEMINI_API_KEY',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    sectionPath: 'deepseek',
    enabledPath: 'deepseek.enabled',
    baseUrlPath: 'deepseek.baseUrl',
    secretName: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'xai',
    label: 'xAI',
    sectionPath: 'xai',
    enabledPath: 'xai.enabled',
    baseUrlPath: 'xai.baseUrl',
    secretName: 'XAI_API_KEY',
  },
  {
    id: 'zai',
    label: 'Z.AI',
    sectionPath: 'zai',
    enabledPath: 'zai.enabled',
    baseUrlPath: 'zai.baseUrl',
    secretName: 'ZAI_API_KEY',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    sectionPath: 'kimi',
    enabledPath: 'kimi.enabled',
    baseUrlPath: 'kimi.baseUrl',
    secretName: 'KIMI_API_KEY',
  },
  {
    id: 'minimax',
    label: 'MiniMax',
    sectionPath: 'minimax',
    enabledPath: 'minimax.enabled',
    baseUrlPath: 'minimax.baseUrl',
    secretName: 'MINIMAX_API_KEY',
  },
  {
    id: 'dashscope',
    label: 'DashScope',
    sectionPath: 'dashscope',
    enabledPath: 'dashscope.enabled',
    baseUrlPath: 'dashscope.baseUrl',
    secretName: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'xiaomi',
    label: 'Xiaomi',
    sectionPath: 'xiaomi',
    enabledPath: 'xiaomi.enabled',
    baseUrlPath: 'xiaomi.baseUrl',
    secretName: 'XIAOMI_API_KEY',
  },
  {
    id: 'kilo',
    label: 'Kilo Code',
    sectionPath: 'kilo',
    enabledPath: 'kilo.enabled',
    baseUrlPath: 'kilo.baseUrl',
    secretName: 'KILO_API_KEY',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    sectionPath: 'local.backends.ollama',
    enabledPath: 'local.backends.ollama.enabled',
    baseUrlPath: 'local.backends.ollama.baseUrl',
  },
  {
    id: 'lmstudio',
    label: 'LM Studio',
    sectionPath: 'local.backends.lmstudio',
    enabledPath: 'local.backends.lmstudio.enabled',
    baseUrlPath: 'local.backends.lmstudio.baseUrl',
  },
  {
    id: 'llamacpp',
    label: 'llama.cpp',
    sectionPath: 'local.backends.llamacpp',
    enabledPath: 'local.backends.llamacpp.enabled',
    baseUrlPath: 'local.backends.llamacpp.baseUrl',
  },
  {
    id: 'vllm',
    label: 'vLLM',
    sectionPath: 'local.backends.vllm',
    enabledPath: 'local.backends.vllm.enabled',
    baseUrlPath: 'local.backends.vllm.baseUrl',
    secretName: 'VLLM_API_KEY',
    secretPath: 'local.backends.vllm.apiKey',
  },
];

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
          <Field>
            <FieldLabel>API key secret</FieldLabel>
            <SecretRefPicker
              value={secretRefId(
                descriptor.secretPath
                  ? settingValue(props.draft, descriptor.secretPath)
                  : undefined,
                descriptor.secretName,
              )}
              disabled={!descriptor.secretPath}
              onValueChange={(id) => {
                if (!descriptor.secretPath) return;
                props.onSettingChange(
                  descriptor.secretPath,
                  id ? { source: 'store', id } : '',
                );
              }}
            />
            {!descriptor.secretPath ? (
              <FieldDescription>
                This provider reads the canonical {descriptor.secretName}{' '}
                secret.
              </FieldDescription>
            ) : null}
          </Field>
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
  filter: string;
  statuses: ReadonlyArray<[string, ProviderEntry]>;
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

  const needle = props.filter.trim().toLowerCase();
  const visibleProviders = PROVIDERS.filter(
    (provider) =>
      settingValue(draft, provider.sectionPath) !== undefined &&
      (!needle ||
        `${provider.label} ${provider.id}`.toLowerCase().includes(needle)),
  );
  const statusMap = new Map(props.statuses);

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
      <div className={styles.providerGrid}>
        {visibleProviders.map((descriptor) => (
          <ProviderConfigCard
            key={descriptor.id}
            descriptor={descriptor}
            draft={draft}
            status={statusMap.get(descriptor.id)}
            onSettingChange={(path, value) =>
              setDraft((current) =>
                current ? withSettingValue(current, path, value) : current,
              )
            }
          />
        ))}
      </div>
      {visibleProviders.length === 0 ? (
        <div className="empty-state">No providers match this filter.</div>
      ) : null}
      <div className={styles.credentialsLink}>
        <a href="/admin/credentials">Manage all credentials →</a>
      </div>
    </Form>
  );
}
