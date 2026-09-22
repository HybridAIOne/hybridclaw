/**
 * One editor owns tiers, classifier, policy mode, visibility.
 * Saves preserve untouched settings from the latest config; models belong only to tiers.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { fetchConfig, requestJson, saveConfig } from '../api/client';
import type { AdminConfig, ChatModel } from '../api/types';
import { useAuth } from '../auth';
import { settingValue, withSettingValue } from '../lib/settings-registry';
import { Button } from './button';
import { Card, CardContent, CardHeader, CardTitle } from './card';
import { Input } from './input';
import { NativeSelect } from './native-select';
import styles from './routing-configuration.module.css';
import { Switch } from './switch';
import { useToast } from './toast';

interface Tier {
  id: string;
  modelIds: string[];
  name: string;
  models: string[];
  modelsByMode?: Partial<Record<Ladder['mode'], string[]>>;
}
interface Ladder {
  localOnly: boolean;
  mode: 'privacy' | 'speed' | 'cost' | 'auto';
  concierge: { model: string; comparisonModel: string };
  showRoutingInfo: boolean;
  evaluator: { mode: 'off' | 'shadow' | 'active'; [key: string]: unknown };
  enabled: boolean;
  tiers: Tier[];
  defaultStart: string;
}
const modes = ['auto', 'privacy', 'speed', 'cost'] as const;
function readLadder(config: AdminConfig, catalog: ChatModel[]): Ladder {
  const mode =
    (settingValue(config, 'routing.mode') as Ladder['mode']) ?? 'auto';
  const tiers =
    (settingValue(config, 'routing.tiers') as Tier[] | undefined) ?? [];
  const price = (id: string) => {
    const entry = catalog.find((m) => m.id === id) as
      | (ChatModel & {
          pricingUsdPerToken?: { input: number | null; output: number | null };
        })
      | undefined;
    const p = entry?.pricingUsdPerToken;
    return p?.input != null && p.output != null ? p.input + p.output : Infinity;
  };
  const zone = (id: string) =>
    ['local', 'hai', 'region', 'cloud'].indexOf(
      catalog.find((m) => m.id === id)?.zone ?? 'cloud',
    );
  return {
    localOnly: Boolean(
      settingValue(config, 'routing.localOnly') ?? mode === 'privacy',
    ),
    enabled: Boolean(settingValue(config, 'routing.enabled')),
    mode: (settingValue(config, 'routing.mode') as Ladder['mode']) ?? 'auto',
    concierge: {
      model: (settingValue(config, 'routing.concierge.model') as string) ?? '',
      comparisonModel:
        (settingValue(config, 'routing.concierge.comparisonModel') as string) ??
        'jev/jev-latest',
    },
    showRoutingInfo: Boolean(settingValue(config, 'routing.showRoutingInfo')),
    evaluator: (settingValue(
      config,
      'routing.evaluator',
    ) as Ladder['evaluator']) ?? { mode: 'off' },
    tiers: tiers.map((tier) => {
      const eligible = [...tier.models];
      const modelsByMode = {
        auto: [...tier.models],
        privacy: [...eligible].sort((a, b) => zone(a) - zone(b)),
        cost: [...eligible].sort((a, b) => price(a) - price(b)),
        speed: [...eligible].sort(
          (a, b) =>
            (catalog.find((m) => m.id === a)?.latencyMs ?? Infinity) -
            (catalog.find((m) => m.id === b)?.latencyMs ?? Infinity),
        ),
        ...tier.modelsByMode,
      };
      const models = modelsByMode[mode];
      return {
        ...tier,
        modelsByMode,
        models,
        id: crypto.randomUUID(),
        modelIds: models.map(() => crypto.randomUUID()),
      };
    }),
    defaultStart:
      (settingValue(config, 'routing.defaultStart') as string | undefined) ??
      '',
  };
}

export function RoutingConfiguration({ models }: { models: ChatModel[] }) {
  const { token } = useAuth();
  const client = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ['config', token],
    queryFn: () => fetchConfig(token),
  });
  const availability = useQuery({
    queryKey: ['routing-status', token],
    queryFn: () =>
      requestJson<{ jevAvailable: boolean }>('/api/admin/routing/status', {
        token,
      }),
  });
  const [draft, setDraft] = useState<Ladder | null>(null);
  const saved = useMemo(
    () => (query.data ? readLadder(query.data.config, models) : null),
    [query.data, models],
  );
  const value = draft ?? saved;
  const mutation = useMutation({
    mutationFn: async (ladder: Ladder) => {
      const latest = await fetchConfig(token);
      let config = latest.config;
      for (const key of [
        'enabled',
        'localOnly',
        'tiers',
        'defaultStart',
        'mode',
        'concierge',
        'showRoutingInfo',
        'evaluator',
      ] as const) {
        if (
          saved &&
          key !== 'tiers' &&
          key !== 'localOnly' &&
          JSON.stringify(ladder[key]) === JSON.stringify(saved[key])
        )
          continue;
        config = withSettingValue(
          config,
          `routing.${key}`,
          key === 'tiers'
            ? ladder.tiers.map((tier) => ({
                name: tier.name,
                models: tier.modelsByMode?.auto ?? tier.models,
                modelsByMode: {
                  ...tier.modelsByMode,
                  [ladder.mode]: tier.models,
                },
              }))
            : ladder[key],
        );
      }
      for (const modelId of new Set([
        ...ladder.tiers.flatMap((tier) => [
          ...tier.models,
          ...Object.values(tier.modelsByMode ?? {}).flat(),
        ]),
        ladder.concierge.model,
        ladder.concierge.comparisonModel,
      ])) {
        const model = models.find((entry) => entry.id === modelId);
        if (!model || model.backend) continue;
        const section =
          model.provider === 'openai-codex' ? 'codex' : model.provider;
        const path = `${section}.models`;
        const configured = settingValue(config, path);
        if (Array.isArray(configured) && !configured.includes(modelId)) {
          config = withSettingValue(config, path, [...configured, modelId]);
        }
      }
      return saveConfig(token, config);
    },
    onSuccess: (payload) => {
      client.setQueryData(['config', token], payload);
      setDraft(null);
      toast.success('Model routing saved.');
    },
  });
  function edit(next: Ladder) {
    mutation.reset();
    setDraft(next);
  }
  function changeTier(index: number, tier: Tier) {
    if (!value) return;
    edit({
      ...value,
      defaultStart:
        value.defaultStart === value.tiers[index].name
          ? tier.name
          : value.defaultStart,
      tiers: value.tiers.map((item, i) =>
        i === index
          ? {
              ...tier,
              modelsByMode: Object.fromEntries(
                modes.map((mode) => [
                  mode,
                  mode === value.mode ||
                  !tier.modelsByMode?.[mode]?.some(Boolean)
                    ? [...tier.models]
                    : tier.modelsByMode[mode],
                ]),
              ),
            }
          : item,
      ),
    });
  }
  function move(index: number, offset: number) {
    if (!value) return;
    const tiers = [...value.tiers];
    [tiers[index], tiers[index + offset]] = [
      tiers[index + offset],
      tiers[index],
    ];
    edit({ ...value, tiers });
  }
  const isLocal = (id: string) =>
    models.some((model) => model.id === id && model.zone === 'local');
  const selectableModels = value?.localOnly
    ? models.filter((model) => model.zone === 'local')
    : models;
  const names =
    value?.tiers.map((tier) => tier.name.trim().toLowerCase()) ?? [];
  const error =
    value &&
    (value.localOnly &&
    (!value.tiers.length ||
      value.tiers.some((tier) => tier.models.some((id) => !isLocal(id))))
      ? 'Configure a local model first.'
      : value.localOnly &&
          (!isLocal(value.concierge.model) ||
            Boolean(
              value.concierge.comparisonModel &&
                !isLocal(value.concierge.comparisonModel),
            ))
        ? 'Choose a local router and clear any cloud comparison router.'
        : value.enabled && !value.tiers.length
          ? 'Add a tier before enabling automatic routing.'
          : names.some((name) => !name)
            ? 'Give every tier a name.'
            : new Set(names).size !== names.length
              ? 'Use a different name for each tier.'
              : value.tiers.some(
                    (tier) =>
                      tier.models.some((model) => !model) ||
                      !tier.models.length,
                  )
                ? 'Choose a model for every slot.'
                : value.tiers.some(
                      (tier) =>
                        new Set(tier.models).size !== tier.models.length,
                    )
                  ? 'Choose different models within each tier.'
                  : value.tiers.length &&
                      !value.tiers.some(
                        (tier) => tier.name === value.defaultStart,
                      )
                    ? 'Choose a starting tier.'
                    : null);
  return (
    <Card id="routing-concierge">
      <CardHeader>
        <CardTitle>Routing</CardTitle>
      </CardHeader>
      <CardContent>
        {!value ? (
          <p role={query.isError ? 'alert' : 'status'}>
            {query.isError
              ? 'Unable to load routing settings.'
              : 'Loading routing settings…'}
          </p>
        ) : (
          <fieldset className={styles.editor} disabled={mutation.isPending}>
            <label className={styles.toggle}>
              <Switch
                checked={value.enabled}
                onCheckedChange={(enabled) => edit({ ...value, enabled })}
              />
              Automatic model routing
            </label>
            <div className="two-column-grid">
              <label className={styles.field}>
                Mode
                <NativeSelect
                  value={value.mode}
                  onChange={(event) =>
                    edit({
                      ...value,
                      mode: event.target.value as Ladder['mode'],
                      tiers: value.tiers.map((tier) => {
                        const modelsByMode = {
                          ...tier.modelsByMode,
                          [value.mode]: [...tier.models],
                        };
                        const models =
                          modelsByMode[event.target.value as Ladder['mode']] ??
                          tier.models;
                        return {
                          ...tier,
                          modelsByMode,
                          models,
                          modelIds: models.map(() => crypto.randomUUID()),
                        };
                      }),
                    })
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="privacy">Privacy</option>
                  <option value="speed">Speed</option>
                  <option value="cost">Cost</option>
                </NativeSelect>
              </label>
              <label className={styles.toggle}>
                <Switch
                  checked={value.localOnly}
                  onCheckedChange={(localOnly) =>
                    edit({
                      ...value,
                      localOnly,
                      concierge: localOnly
                        ? {
                            model: isLocal(value.concierge.model)
                              ? value.concierge.model
                              : '',
                            comparisonModel: isLocal(
                              value.concierge.comparisonModel,
                            )
                              ? value.concierge.comparisonModel
                              : '',
                          }
                        : value.concierge,
                    })
                  }
                />
                Local models only
              </label>
              {(['model', 'comparisonModel'] as const).map((field) => (
                <label key={field} className={styles.field}>
                  {field === 'model'
                    ? '1st router · Live'
                    : '2nd router · Compare'}
                  <NativeSelect
                    value={
                      value.localOnly &&
                      value.concierge[field] &&
                      !isLocal(value.concierge[field])
                        ? '__blocked__'
                        : field === 'comparisonModel' &&
                            value.concierge[field].startsWith('jev/') &&
                            availability.data?.jevAvailable === false
                          ? ''
                          : value.concierge[field]
                    }
                    onChange={(event) =>
                      edit({
                        ...value,
                        concierge: {
                          ...value.concierge,
                          [field]: event.target.value,
                        },
                      })
                    }
                  >
                    {value.localOnly &&
                      value.concierge[field] &&
                      !isLocal(value.concierge[field]) && (
                        <option value="__blocked__" disabled>
                          Choose a local router…
                        </option>
                      )}
                    <option value="">
                      {field === 'model'
                        ? value.localOnly
                          ? 'Choose a local router…'
                          : 'Automatic · Gemma E4B'
                        : 'Unset'}
                    </option>
                    {!value.localOnly && (
                      <option
                        value="jev/jev-latest"
                        disabled={!availability.data?.jevAvailable}
                      >
                        JEV
                        {availability.data?.jevAvailable
                          ? ''
                          : ' · API key required'}
                      </option>
                    )}
                    {!value.localOnly &&
                    value.concierge[field] &&
                    !value.concierge[field].startsWith('jev/') &&
                    !models.some(
                      (model) => model.id === value.concierge[field],
                    ) ? (
                      <option value={value.concierge[field]}>
                        {value.concierge[field]}
                      </option>
                    ) : null}
                    {selectableModels
                      .filter((model) => !model.id.startsWith('jev/'))
                      .map((model) => (
                        <option key={model.id} value={model.id}>
                          {model.id}
                        </option>
                      ))}
                  </NativeSelect>
                </label>
              ))}
              <label className={styles.toggle}>
                <Switch
                  checked={value.showRoutingInfo}
                  onCheckedChange={(showRoutingInfo) =>
                    edit({ ...value, showRoutingInfo })
                  }
                />
                Show routing in chat
              </label>
            </div>
            <p className={styles.help}>
              {
                {
                  auto: 'Balance cost and measured speed.',
                  privacy: 'Prefer local, then private endpoints, then cloud.',
                  speed: 'Prefer the fastest measured model.',
                  cost: 'Prefer the cheapest capable model.',
                }[value.mode]
              }{' '}
              Models below are saved for this mode.
            </p>
            {value.mode === 'privacy' &&
              !value.tiers.some((tier) =>
                tier.models.some((id) =>
                  models.some(
                    (model) =>
                      model.id === id && model.zone && model.zone !== 'cloud',
                  ),
                ),
              ) && (
                <p className={styles.help}>
                  Only cloud models are assigned. Add a local or private
                  endpoint model to these tiers.
                </p>
              )}
            {(value.mode === 'speed' || value.mode === 'auto') &&
              !value.tiers.some((tier) =>
                tier.models.some((id) =>
                  models.some(
                    (model) => model.id === id && model.latencyMs != null,
                  ),
                ),
              ) && (
                <p className={styles.help}>
                  No timings yet · using configured order.
                </p>
              )}
            <ol className={styles.tiers}>
              {value.tiers.map((tier, index) => (
                <li key={tier.id} className={styles.tier}>
                  <div className={styles.heading}>
                    <div className={styles.actions}>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Move tier ${index + 1} earlier`}
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                      >
                        ↑
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Move tier ${index + 1} later`}
                        disabled={index === value.tiers.length - 1}
                        onClick={() => move(index, 1)}
                      >
                        ↓
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        aria-label={`Remove tier ${index + 1}`}
                        onClick={() => {
                          const tiers = value.tiers.filter(
                            (_, i) => i !== index,
                          );
                          edit({
                            ...value,
                            tiers,
                            defaultStart:
                              value.defaultStart === tier.name
                                ? (tiers[0]?.name ?? '')
                                : value.defaultStart,
                          });
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                  <label className={`${styles.field} ${styles.name}`}>
                    Tier {index + 1}
                    <Input
                      size="sm"
                      aria-label={`Tier ${index + 1} name`}
                      value={tier.name}
                      placeholder="e.g. Local, Balanced, Powerful"
                      onChange={(event) =>
                        changeTier(index, { ...tier, name: event.target.value })
                      }
                    />
                  </label>
                  {tier.models.map((model, modelIndex) => (
                    <div
                      key={tier.modelIds[modelIndex]}
                      className={
                        modelIndex === 0 ? styles.model : styles.backup
                      }
                    >
                      <label className={styles.field}>
                        {modelIndex === 0
                          ? 'Try first'
                          : `Backup ${modelIndex}`}
                        <NativeSelect
                          size="sm"
                          aria-label={`Tier ${index + 1} model ${modelIndex + 1}`}
                          value={
                            value.localOnly && !isLocal(model) ? '' : model
                          }
                          onChange={(event) =>
                            changeTier(index, {
                              ...tier,
                              models: tier.models.map((item, i) =>
                                i === modelIndex ? event.target.value : item,
                              ),
                            })
                          }
                        >
                          <option value="">
                            {value.localOnly
                              ? 'Choose a local model…'
                              : 'Choose a model…'}
                          </option>
                          {model &&
                          !value.localOnly &&
                          !models.some((item) => item.id === model) ? (
                            <option value={model}>
                              {model} · not in current catalog
                            </option>
                          ) : null}
                          {selectableModels.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.id} ·{' '}
                              {item.zone === 'local'
                                ? 'Local'
                                : item.zone === 'hai'
                                  ? 'HybridAI'
                                  : item.zone === 'region'
                                    ? 'Regional'
                                    : item.zone === 'cloud'
                                      ? 'Cloud'
                                      : 'Location unknown'}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                      {modelIndex > 0 ? (
                        <Button
                          variant="ghost"
                          aria-label={`Remove tier ${index + 1} backup ${modelIndex}`}
                          onClick={() =>
                            changeTier(index, {
                              ...tier,
                              modelIds: tier.modelIds.filter(
                                (_, i) => i !== modelIndex,
                              ),
                              models: tier.models.filter(
                                (_, i) => i !== modelIndex,
                              ),
                            })
                          }
                        >
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ))}
                  <Button
                    className={styles.addBackup}
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      changeTier(index, {
                        ...tier,
                        models: [...tier.models, ''],
                        modelIds: [...tier.modelIds, crypto.randomUUID()],
                      })
                    }
                  >
                    + Add backup model
                  </Button>
                </li>
              ))}
            </ol>
            {!value.tiers.length ? (
              <p className={styles.help}>Add a tier to get started.</p>
            ) : null}
            <Button
              className={styles.addTier}
              size="sm"
              variant="outline"
              onClick={() => {
                let number = value.tiers.length + 1;
                while (names.includes(`tier ${number}`)) number++;
                const name = `Tier ${number}`;
                edit({
                  ...value,
                  tiers: [
                    ...value.tiers,
                    {
                      name,
                      models: [''],
                      id: crypto.randomUUID(),
                      modelIds: [crypto.randomUUID()],
                    },
                  ],
                  defaultStart: value.defaultStart || name,
                });
              }}
            >
              + Add tier
            </Button>
            {value.tiers.length ? (
              <label className={styles.field}>
                Default tier · classifier unavailable
                <NativeSelect
                  value={value.defaultStart}
                  onChange={(event) =>
                    edit({ ...value, defaultStart: event.target.value })
                  }
                >
                  <option value="" disabled>
                    Choose a starting tier…
                  </option>
                  {value.tiers.map((tier, index) => (
                    <option key={tier.id} value={tier.name}>
                      {index + 1}. {tier.name || 'Unnamed tier'}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            ) : null}
            {error ? <p role="alert">{error}</p> : null}
            {mutation.isError ? (
              <p role="alert">
                Could not save routing: {mutation.error.message}
              </p>
            ) : null}
            <div className={styles.actions}>
              <Button
                disabled={
                  !draft ||
                  Boolean(error) ||
                  (value.concierge.model.startsWith('jev/') &&
                    !availability.data?.jevAvailable)
                }
                loading={mutation.isPending}
                onClick={() =>
                  mutation.mutate({
                    ...value,
                    tiers: value.tiers.map((tier) => ({
                      ...tier,
                      name: tier.name.trim(),
                    })),
                    defaultStart: value.defaultStart.trim(),
                  })
                }
              >
                Save routing
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
              <a href="/chat">Open chat →</a>
            </div>
          </fieldset>
        )}
      </CardContent>
    </Card>
  );
}
