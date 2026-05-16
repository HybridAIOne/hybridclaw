import { useMutation, useQuery } from '@tanstack/react-query';
import {
  type Dispatch,
  type SetStateAction,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { fetchConfig, saveConfig } from '../api/client';
import type { AdminConfig } from '../api/types';
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

  if (configQuery.isLoading && !draft) {
    return <div className="empty-state">Loading runtime config...</div>;
  }

  if (!draft || !configQuery.data) {
    return <div className="empty-state">Runtime config is unavailable.</div>;
  }

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
            {jsonError ? <FieldError>{jsonError}</FieldError> : null}
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
          </>
        )}
      </div>
    </div>
  );
}
