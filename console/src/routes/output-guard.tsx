import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchModels,
  fetchOutputGuardProfile,
  previewOutputGuardProfile,
  saveOutputGuardProfile,
} from '../api/client';
import type {
  AdminOutputGuardModelConfig,
  AdminOutputGuardPreviewResponse,
  AdminOutputGuardProfile,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Field, FieldContent, FieldLabel } from '../components/field';
import { Trash } from '../components/icons';
import { Switch } from '../components/switch';
import { useToast } from '../components/toast';
import { PageHeader, SegmentedToggle } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';
import { ModelSwitchSelect, parseModel } from './chat/model-switch-select';

const EMPTY_PROFILE: AdminOutputGuardProfile = {
  enabled: false,
  mode: 'rewrite',
  policy: '',
  doList: [],
  dontList: [],
  bannedPhrases: [],
  bannedPatterns: [],
  requirePhrases: [],
  classifier: {
    provider: 'default',
    model: '',
  },
  rewriter: {
    provider: 'default',
    model: '',
  },
};

function profilesEqual(
  left: AdminOutputGuardProfile,
  right: AdminOutputGuardProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function modelConfigDefaults(
  provider: AdminOutputGuardModelConfig['provider'],
  model = '',
): AdminOutputGuardModelConfig {
  return { provider, model: provider === 'model' ? model.trim() : '' };
}

function formatModelLabel(
  modelId: string | null | undefined,
  models: Awaited<ReturnType<typeof fetchModels>>['models'],
): string {
  const normalized = modelId?.trim() ?? '';
  if (!normalized) return '';
  const entry = models.find((model) => model.id === normalized);
  return entry ? parseModel(entry).displayName : normalized;
}

function cleanProfile(
  profile: AdminOutputGuardProfile,
): AdminOutputGuardProfile {
  const cleanList = (list: string[]) =>
    list.map((entry) => entry.trim()).filter(Boolean);
  return {
    ...profile,
    policy: profile.policy.trim(),
    doList: cleanList(profile.doList),
    dontList: cleanList(profile.dontList),
    bannedPhrases: cleanList(profile.bannedPhrases),
    bannedPatterns: cleanList(profile.bannedPatterns),
    requirePhrases: cleanList(profile.requirePhrases),
    classifier: modelConfigDefaults(
      profile.classifier.provider,
      profile.classifier.model,
    ),
    rewriter: modelConfigDefaults(
      profile.rewriter.provider,
      profile.rewriter.model,
    ),
  };
}

function ListEditor(props: {
  label: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const nextId = useRef(0);
  const createRow = useCallback(
    (value: string) => {
      const row = { id: `${props.label}-${nextId.current}`, value };
      nextId.current += 1;
      return row;
    },
    [props.label],
  );
  const [rows, setRows] = useState<Array<{ id: string; value: string }>>(() =>
    props.values.map(createRow),
  );

  const publishRows = (nextRows: Array<{ id: string; value: string }>) => {
    setRows(nextRows);
    props.onChange(nextRows.map((row) => row.value));
  };

  useEffect(() => {
    setRows((currentRows) =>
      props.values.map((value, index) => {
        if (currentRows[index]?.value === value) return currentRows[index];
        const currentRow = currentRows[index];
        if (currentRow) return { ...currentRow, value };
        return createRow(value);
      }),
    );
  }, [createRow, props.values]);

  return (
    <div className="field output-guard-list-field">
      <span>{props.label}</span>
      <div className="output-guard-list">
        {rows.map((row, index) => (
          <div className="output-guard-list-row" key={row.id}>
            <input
              aria-label={`${props.label} item ${index + 1}`}
              value={row.value}
              onChange={(event) =>
                publishRows(
                  rows.map((currentRow, currentIndex) =>
                    currentIndex === index
                      ? { ...currentRow, value: event.target.value }
                      : currentRow,
                  ),
                )
              }
              placeholder={props.placeholder}
            />
            <button
              className="ghost-button icon-button"
              type="button"
              aria-label={`Remove ${props.label} item ${index + 1}`}
              title="Remove"
              onClick={() => {
                publishRows(
                  rows.filter((_, currentIndex) => currentIndex !== index),
                );
              }}
            >
              <Trash width="16" height="16" />
            </button>
          </div>
        ))}
        <button
          className="ghost-button output-guard-add-button"
          type="button"
          aria-label={`Add ${props.label} item`}
          onClick={() => {
            publishRows([...rows, createRow('')]);
          }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function ModelSourceControl(props: {
  label: string;
  ariaLabel: string;
  value: AdminOutputGuardModelConfig;
  modelOptions: Awaited<ReturnType<typeof fetchModels>>['models'];
  defaultOtherModelId: string;
  activeModelId: string | null;
  activeModelFallback: string;
  modelsLoading: boolean;
  onChange: (value: AdminOutputGuardModelConfig) => void;
}) {
  const selectedModelId =
    props.value.provider === 'model' ? props.value.model : '';
  const activeModelLabel = formatModelLabel(
    props.activeModelId,
    props.modelOptions,
  );
  const readoutLabel = activeModelLabel || props.activeModelFallback;
  return (
    <div className="field">
      <span>{props.label}</span>
      <div
        className={`output-guard-model-source-control has-model-readout ${
          props.value.provider === 'model' ? 'has-model-select' : ''
        }`}
      >
        <SegmentedToggle
          ariaLabel={props.ariaLabel}
          value={props.value.provider}
          options={[
            { value: 'default', label: 'default model' },
            { value: 'auxiliary', label: 'aux model' },
            { value: 'model', label: 'other model' },
          ]}
          onChange={(provider) => {
            const nextProvider =
              provider as AdminOutputGuardModelConfig['provider'];
            const nextModel =
              nextProvider === 'model'
                ? props.value.model || props.defaultOtherModelId
                : '';
            props.onChange(modelConfigDefaults(nextProvider, nextModel));
          }}
        />
        {props.value.provider === 'model' ? (
          <ModelSwitchSelect
            models={props.modelOptions}
            selectedModelId={selectedModelId}
            disabled={props.modelsLoading}
            onSwitch={(model) =>
              props.onChange(modelConfigDefaults('model', model))
            }
          />
        ) : (
          <div
            className="output-guard-model-readout"
            title={props.activeModelId || readoutLabel}
          >
            {readoutLabel}
          </div>
        )}
      </div>
    </div>
  );
}

function formatVerdict(verdict: AdminOutputGuardPreviewResponse['verdict']) {
  if (verdict === 'compliant') return 'compliant';
  if (verdict === 'needs_review') return 'needs review';
  return 'non-compliant';
}

function formatPreviewViolation(
  violation: AdminOutputGuardPreviewResponse['violations'][number],
) {
  if (violation.kind === 'banned_phrase') {
    return `Contains banned phrase "${violation.detail}".`;
  }
  if (violation.kind === 'banned_pattern') {
    return `Matches banned pattern ${violation.detail}.`;
  }
  return `Missing required phrase "${violation.detail}".`;
}

function formatClassifierStatus(
  preview: AdminOutputGuardPreviewResponse,
): string {
  const { classifier } = preview;
  if (classifier.status === 'evaluated' && classifier.verdict) {
    const severity = classifier.severity ? `, ${classifier.severity}` : '';
    const model = classifier.model ? ` via ${classifier.model}` : '';
    const source =
      classifier.provider === 'default'
        ? 'default model'
        : classifier.provider === 'auxiliary'
          ? 'aux model'
          : 'selected model';
    return `Classifier ${source}${model}: ${formatVerdict(classifier.verdict)}${severity}.`;
  }
  if (classifier.status === 'unparseable') {
    return 'Classifier response was not parseable; showing rules score.';
  }
  if (preview.scoreSource === 'classifier') {
    return 'Classifier unavailable; failure mode blocks output.';
  }
  return 'Classifier unavailable; showing rules score.';
}

export function OutputGuardPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [profile, setProfile] =
    useState<AdminOutputGuardProfile>(EMPTY_PROFILE);
  const [sample, setSample] = useState('');
  const [preview, setPreview] =
    useState<AdminOutputGuardPreviewResponse | null>(null);

  const profileQuery = useQuery({
    queryKey: ['output-guard-profile', auth.token],
    queryFn: () => fetchOutputGuardProfile(auth.token),
  });
  const modelsQuery = useQuery({
    queryKey: ['models', auth.token],
    queryFn: () => fetchModels(auth.token),
  });

  useEffect(() => {
    if (profileQuery.data?.profile) {
      setProfile(profileQuery.data.profile);
    }
  }, [profileQuery.data?.profile]);

  const savedProfile = profileQuery.data?.profile ?? EMPTY_PROFILE;
  const hasChanges = !profilesEqual(cleanProfile(profile), savedProfile);
  const modelOptions = modelsQuery.data?.models ?? [];
  const defaultModelId = modelsQuery.data?.defaultModel ?? '';
  const auxiliaryModelId =
    modelsQuery.data?.auxiliaryModels?.skillsHub.model ?? null;
  const auxiliaryProvider =
    modelsQuery.data?.auxiliaryModels?.skillsHub.provider ?? 'auto';
  const defaultOtherModelId =
    modelOptions.find((model) => model.id !== defaultModelId)?.id ??
    defaultModelId;

  useEffect(() => {
    if (!defaultOtherModelId) return;
    if (
      (profile.classifier.provider !== 'model' || profile.classifier.model) &&
      (profile.rewriter.provider !== 'model' || profile.rewriter.model)
    ) {
      return;
    }
    setProfile((current) => {
      let next = current;
      if (
        current.classifier.provider === 'model' &&
        !current.classifier.model
      ) {
        next = {
          ...next,
          classifier: modelConfigDefaults('model', defaultOtherModelId),
        };
      }
      if (current.rewriter.provider === 'model' && !current.rewriter.model) {
        next = {
          ...next,
          rewriter: modelConfigDefaults('model', defaultOtherModelId),
        };
      }
      return next;
    });
  }, [
    defaultOtherModelId,
    profile.classifier.model,
    profile.classifier.provider,
    profile.rewriter.model,
    profile.rewriter.provider,
  ]);

  const saveMutation = useMutation({
    mutationFn: () => saveOutputGuardProfile(auth.token, cleanProfile(profile)),
    onSuccess: (payload) => {
      setProfile(payload.profile);
      toast.success(
        payload.changed ? 'Output guard saved.' : 'Output guard unchanged.',
        payload.reloadMessage,
      );
      queryClient.setQueryData(['output-guard-profile', auth.token], payload);
      queryClient.invalidateQueries({
        queryKey: ['output-guard-profile', auth.token],
      });
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewOutputGuardProfile(auth.token, cleanProfile(profile), sample),
    onSuccess: (payload) => {
      setPreview(payload);
    },
    onError: (error) => {
      toast.error('Preview failed', getErrorMessage(error));
    },
  });

  return (
    <div className="page-stack output-guard-page">
      <PageHeader
        description="Operator controls for output policy, rules, classifier, and rewrite behavior."
        actions={
          <button
            className="primary-button"
            type="button"
            disabled={!hasChanges || saveMutation.isPending}
            onClick={() => saveMutation.mutate()}
          >
            {saveMutation.isPending ? 'Saving...' : 'Save profile'}
          </button>
        }
      />

      <div className="two-column-grid">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
            <CardDescription>Runtime plugin profile</CardDescription>
          </CardHeader>
          <CardContent>
            {profileQuery.isLoading ? (
              <div className="empty-state">Loading output guard...</div>
            ) : profileQuery.isError ? (
              <div className="empty-state">
                {getErrorMessage(profileQuery.error)}
              </div>
            ) : (
              <div className="stack-form">
                <Field orientation="horizontal">
                  <Switch
                    checked={profile.enabled}
                    onCheckedChange={(enabled) =>
                      setProfile((current) => ({ ...current, enabled }))
                    }
                  />
                  <FieldContent>
                    <FieldLabel>Enabled</FieldLabel>
                  </FieldContent>
                </Field>
                <div className="field">
                  <span>Mode</span>
                  <SegmentedToggle
                    ariaLabel="Output guard mode"
                    value={profile.mode}
                    options={[
                      { value: 'rewrite', label: 'rewrite' },
                      { value: 'block', label: 'block' },
                      { value: 'flag', label: 'flag' },
                    ]}
                    onChange={(mode) =>
                      setProfile((current) => ({
                        ...current,
                        mode: mode as AdminOutputGuardProfile['mode'],
                      }))
                    }
                  />
                </div>
                <ModelSourceControl
                  label="Classifier"
                  ariaLabel="Output guard classifier source"
                  value={profile.classifier}
                  modelOptions={modelOptions}
                  defaultOtherModelId={defaultOtherModelId}
                  activeModelId={
                    profile.classifier.provider === 'default'
                      ? defaultModelId
                      : auxiliaryModelId
                  }
                  activeModelFallback={
                    profile.classifier.provider === 'default'
                      ? 'No default model'
                      : auxiliaryProvider === 'disabled'
                        ? 'Aux model disabled'
                        : 'Auto routing'
                  }
                  modelsLoading={modelsQuery.isLoading}
                  onChange={(classifier) =>
                    setProfile((current) => ({ ...current, classifier }))
                  }
                />
                <ModelSourceControl
                  label="Rewriter"
                  ariaLabel="Output guard rewriter source"
                  value={profile.rewriter}
                  modelOptions={modelOptions}
                  defaultOtherModelId={defaultOtherModelId}
                  activeModelId={
                    profile.rewriter.provider === 'default'
                      ? defaultModelId
                      : auxiliaryModelId
                  }
                  activeModelFallback={
                    profile.rewriter.provider === 'default'
                      ? 'No default model'
                      : auxiliaryProvider === 'disabled'
                        ? 'Aux model disabled'
                        : 'Auto routing'
                  }
                  modelsLoading={modelsQuery.isLoading}
                  onChange={(rewriter) =>
                    setProfile((current) => ({ ...current, rewriter }))
                  }
                />
                <label className="field textarea-field">
                  <span>Policy</span>
                  <textarea
                    rows={5}
                    value={profile.policy}
                    onChange={(event) =>
                      setProfile((current) => ({
                        ...current,
                        policy: event.target.value,
                      }))
                    }
                    placeholder="Clear, direct, concrete. No hype."
                  />
                </label>
                <ListEditor
                  label="Do"
                  values={profile.doList}
                  placeholder="Use concrete nouns"
                  onChange={(doList) =>
                    setProfile((current) => ({ ...current, doList }))
                  }
                />
                <ListEditor
                  label="Don't"
                  values={profile.dontList}
                  placeholder="Use hype or vague claims"
                  onChange={(dontList) =>
                    setProfile((current) => ({ ...current, dontList }))
                  }
                />
                <small className="output-guard-list-note">
                  Do and Don't guide rewrites and classifier context; banned and
                  required rules stay deterministic.
                </small>
                <ListEditor
                  label="Banned phrases"
                  values={profile.bannedPhrases}
                  placeholder="game changing"
                  onChange={(bannedPhrases) =>
                    setProfile((current) => ({ ...current, bannedPhrases }))
                  }
                />
                <ListEditor
                  label="Banned patterns"
                  values={profile.bannedPatterns}
                  placeholder="/\\bguarantee[sd]?\\b/i"
                  onChange={(bannedPatterns) =>
                    setProfile((current) => ({ ...current, bannedPatterns }))
                  }
                />
                <ListEditor
                  label="Required phrases"
                  values={profile.requirePhrases}
                  placeholder="Best regards"
                  onChange={(requirePhrases) =>
                    setProfile((current) => ({ ...current, requirePhrases }))
                  }
                />
              </div>
            )}
          </CardContent>
        </Card>

        <div className="page-stack">
          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
              <CardDescription>
                {preview
                  ? `${preview.score}/100, ${formatVerdict(preview.verdict)} (${preview.scoreSource})`
                  : 'No score yet'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <label className="field textarea-field">
                <span>Sample output</span>
                <textarea
                  rows={9}
                  value={sample}
                  onChange={(event) => setSample(event.target.value)}
                  placeholder="Paste assistant output"
                />
              </label>
              <button
                className="primary-button"
                type="button"
                disabled={!sample.trim() || previewMutation.isPending}
                onClick={() => previewMutation.mutate()}
              >
                {previewMutation.isPending ? 'Scoring...' : 'Score sample'}
              </button>
              {preview ? (
                <div className="output-guard-score-panel">
                  <div className="output-guard-score-bar">
                    <span style={{ width: `${preview.score}%` }} />
                  </div>
                  <small>{formatClassifierStatus(preview)}</small>
                  {preview.violations.length > 0 ? (
                    <ul className="output-guard-reason-list">
                      {preview.violations.map((violation) => {
                        const reason = formatPreviewViolation(violation);
                        return <li key={reason}>{reason}</li>;
                      })}
                    </ul>
                  ) : (
                    <small>No rule violations detected.</small>
                  )}
                  {preview.classifier.reasons.length > 0 ? (
                    <ul className="output-guard-reason-list">
                      {preview.classifier.reasons.map((reason) => (
                        <li key={`classifier-${reason}`}>{reason}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card variant="muted">
            <CardHeader>
              <CardTitle>Versions</CardTitle>
              <CardDescription>
                {`${profileQuery.data?.revisions.length ?? 0} profile edits`}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {profileQuery.data?.revisions.length ? (
                <div className="list-stack selectable-list">
                  {profileQuery.data.revisions.map((revision) => (
                    <div className="list-row" key={revision.id}>
                      <div>
                        <strong>Revision {revision.id}</strong>
                        <small>{formatDateTime(revision.createdAt)}</small>
                        <small>{revision.actor}</small>
                      </div>
                      <span className="list-status">{revision.source}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="empty-state">No saved profile edits yet.</div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
