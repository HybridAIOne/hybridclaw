/**
 * Concierge configuration selects the decision model, separately from execution models.
 * Secret metadata controls JEV availability; credentials never enter this form.
 * Saves merge only concierge settings into the latest runtime configuration.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { RuntimeRoutingConciergeConfig } from '../../../src/config/runtime-config';
import { fetchConfig, requestJson, saveConfig } from '../api/client';
import type { ChatModel } from '../api/types';
import { useAuth } from '../auth';
import { settingValue, withSettingValue } from '../lib/settings-registry';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { NativeSelect } from './native-select';
import styles from './routing-configuration.module.css';
import { Switch } from './switch';

export function ConciergeSettings({ models }: { models: ChatModel[] }) {
  const { token } = useAuth();
  const client = useQueryClient();
  const query = useQuery({
    queryKey: ['config', token],
    queryFn: () => fetchConfig(token),
  });
  const secrets = useQuery({
    queryKey: ['routing-status', token],
    queryFn: () =>
      requestJson<{ jevAvailable: boolean }>('/api/admin/routing/status', {
        token,
      }),
    retry: false,
  });
  const [draft, setDraft] = useState<RuntimeRoutingConciergeConfig | null>(
    null,
  );
  const saved = query.data
    ? (settingValue(
        query.data.config,
        'routing.concierge',
      ) as RuntimeRoutingConciergeConfig)
    : null;
  const value = draft ?? saved;
  const jevAvailable = secrets.data?.jevAvailable === true;
  const isJev = value?.model.startsWith('jev/');
  const mutation = useMutation({
    mutationFn: async (concierge: RuntimeRoutingConciergeConfig) => {
      const latest = await fetchConfig(token);
      let config = withSettingValue(
        latest.config,
        'routing.concierge',
        concierge,
      );
      for (const id of [
        concierge.model,
        ...Object.values(concierge.profiles),
      ]) {
        const model = models.find((item) => item.id === id);
        if (!model || model.backend) continue;
        const section =
          model.provider === 'openai-codex' ? 'codex' : model.provider;
        const path = `${section}.models`;
        const configured = settingValue(config, path);
        if (Array.isArray(configured) && !configured.includes(id))
          config = withSettingValue(config, path, [...configured, id]);
      }
      return saveConfig(token, config);
    },
    onSuccess: (payload) => {
      client.setQueryData(['config', token], payload);
      setDraft(null);
    },
  });
  function edit(next: RuntimeRoutingConciergeConfig) {
    mutation.reset();
    setDraft(next);
  }
  function modelOptions(selected: string) {
    return (
      <>
        {selected &&
        !selected.startsWith('jev/') &&
        !models.some((item) => item.id === selected) ? (
          <option value={selected}>{selected}</option>
        ) : null}
        {models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.id}
          </option>
        ))}
      </>
    );
  }
  return (
    <Card id="routing-concierge">
      <CardHeader>
        <CardTitle>Routing concierge</CardTitle>
      </CardHeader>
      <CardContent>
        {!value ? (
          <p role="status">
            {query.isError
              ? 'Unable to load concierge settings.'
              : 'Loading concierge settings…'}
          </p>
        ) : (
          <fieldset className={styles.editor} disabled={mutation.isPending}>
            <label className={styles.toggle}>
              <Switch
                checked={value.enabled}
                onCheckedChange={(enabled) => edit({ ...value, enabled })}
              />
              Enable concierge
            </label>
            <label className={styles.field}>
              Concierge model
              <NativeSelect
                value={value.model}
                onChange={(event) =>
                  edit({ ...value, model: event.target.value })
                }
              >
                <option value="jev/jev-latest" disabled={!jevAvailable}>
                  JEV · Typed routing
                  {jevAvailable
                    ? ''
                    : secrets.isPending
                      ? ' · Checking key…'
                      : ' · JEV_API_KEY required'}
                </option>
                {isJev && value.model !== 'jev/jev-latest' ? (
                  <option value={value.model} disabled={!jevAvailable}>
                    {value.model}
                  </option>
                ) : null}
                {modelOptions(value.model)}
              </NativeSelect>
            </label>
            {!jevAvailable ? (
              <p className={styles.help}>
                Add JEV_API_KEY in <a href="/admin/secrets">Secrets</a>.
              </p>
            ) : null}
            {isJev ? (
              <>
                <p className={styles.help}>
                  Sends current prompt text to JEV. Excludes history and
                  attachments.
                </p>
                {!(
                  query.data &&
                  settingValue(query.data.config, 'routing.enabled')
                ) ? (
                  <p role="status">Enable model routing to use JEV.</p>
                ) : null}
              </>
            ) : (
              <>
                {(['asap', 'balanced', 'noHurry'] as const).map(
                  (profile, index) => (
                    <label key={profile} className={styles.field}>
                      {
                        ['As soon as possible', 'Can wait a bit', 'No hurry'][
                          index
                        ]
                      }
                      <NativeSelect
                        value={value.profiles[profile]}
                        onChange={(event) =>
                          edit({
                            ...value,
                            profiles: {
                              ...value.profiles,
                              [profile]: event.target.value,
                            },
                          })
                        }
                      >
                        {modelOptions(value.profiles[profile])}
                      </NativeSelect>
                    </label>
                  ),
                )}
              </>
            )}
            {mutation.isError ? (
              <p role="alert">Could not save concierge settings.</p>
            ) : null}
            {mutation.isSuccess ? (
              <p role="status">Concierge settings saved.</p>
            ) : null}
            <div className={styles.actions}>
              <Button
                disabled={
                  !draft || Boolean(value.enabled && isJev && !jevAvailable)
                }
                loading={mutation.isPending}
                onClick={() => mutation.mutate(value)}
              >
                Save concierge
              </Button>
              <Button
                variant="ghost"
                disabled={!draft}
                onClick={() => {
                  setDraft(null);
                  mutation.reset();
                }}
              >
                Discard changes
              </Button>
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
