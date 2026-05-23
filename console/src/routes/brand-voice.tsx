import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchBrandVoiceProfile,
  previewBrandVoiceProfile,
  saveBrandVoiceProfile,
} from '../api/client';
import type {
  AdminBrandVoiceClassifierConfig,
  AdminBrandVoicePreviewResponse,
  AdminBrandVoiceProfile,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import { Trash } from '../components/icons';
import { useToast } from '../components/toast';
import { BooleanField, PageHeader, SegmentedToggle } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';

const EMPTY_PROFILE: AdminBrandVoiceProfile = {
  enabled: true,
  mode: 'rewrite',
  voice: '',
  doList: [],
  dontList: [],
  bannedPhrases: [],
  bannedPatterns: [],
  requirePhrases: [],
  classifier: {
    provider: 'rules',
  },
};

function profilesEqual(
  left: AdminBrandVoiceProfile,
  right: AdminBrandVoiceProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classifierDefaults(
  provider: AdminBrandVoiceClassifierConfig['provider'],
): AdminBrandVoiceClassifierConfig {
  return { provider };
}

function cleanProfile(profile: AdminBrandVoiceProfile): AdminBrandVoiceProfile {
  const cleanList = (list: string[]) =>
    list.map((entry) => entry.trim()).filter(Boolean);
  return {
    ...profile,
    voice: profile.voice.trim(),
    doList: cleanList(profile.doList),
    dontList: cleanList(profile.dontList),
    bannedPhrases: cleanList(profile.bannedPhrases),
    bannedPatterns: cleanList(profile.bannedPatterns),
    requirePhrases: cleanList(profile.requirePhrases),
    classifier: classifierDefaults(profile.classifier.provider),
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
    <div className="field brand-voice-list-field">
      <span>{props.label}</span>
      <div className="brand-voice-list">
        {rows.map((row, index) => (
          <div className="brand-voice-list-row" key={row.id}>
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
          className="ghost-button brand-voice-add-button"
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

function formatVerdict(verdict: AdminBrandVoicePreviewResponse['verdict']) {
  if (verdict === 'on_brand') return 'on brand';
  if (verdict === 'needs_review') return 'needs review';
  return 'off brand';
}

function formatPreviewViolation(
  violation: AdminBrandVoicePreviewResponse['violations'][number],
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
  preview: AdminBrandVoicePreviewResponse,
): string {
  const { classifier } = preview;
  if (classifier.status === 'evaluated' && classifier.verdict) {
    const severity = classifier.severity ? `, ${classifier.severity}` : '';
    const model = classifier.model ? ` via ${classifier.model}` : '';
    return `Classifier ${classifier.provider}${model}: ${formatVerdict(classifier.verdict)}${severity}.`;
  }
  if (classifier.status === 'rules_only') {
    return 'Rules-only classifier; using deterministic rule score.';
  }
  if (classifier.status === 'unparseable') {
    return 'Classifier response was not parseable; showing rules score.';
  }
  if (preview.scoreSource === 'classifier') {
    return 'Classifier unavailable; failure mode blocks output.';
  }
  return 'Classifier unavailable; showing rules score.';
}

export function BrandVoicePage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [profile, setProfile] = useState<AdminBrandVoiceProfile>(EMPTY_PROFILE);
  const [sample, setSample] = useState('');
  const [preview, setPreview] = useState<AdminBrandVoicePreviewResponse | null>(
    null,
  );

  const profileQuery = useQuery({
    queryKey: ['brand-voice-profile', auth.token],
    queryFn: () => fetchBrandVoiceProfile(auth.token),
  });

  useEffect(() => {
    if (profileQuery.data?.profile) {
      setProfile(profileQuery.data.profile);
    }
  }, [profileQuery.data?.profile]);

  const savedProfile = profileQuery.data?.profile ?? EMPTY_PROFILE;
  const hasChanges = !profilesEqual(cleanProfile(profile), savedProfile);

  const saveMutation = useMutation({
    mutationFn: () => saveBrandVoiceProfile(auth.token, cleanProfile(profile)),
    onSuccess: (payload) => {
      setProfile(payload.profile);
      toast.success(
        payload.changed ? 'Brand voice saved.' : 'Brand voice unchanged.',
        payload.reloadMessage,
      );
      queryClient.setQueryData(['brand-voice-profile', auth.token], payload);
      queryClient.invalidateQueries({
        queryKey: ['brand-voice-profile', auth.token],
      });
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
    },
  });

  const previewMutation = useMutation({
    mutationFn: () =>
      previewBrandVoiceProfile(auth.token, cleanProfile(profile), sample),
    onSuccess: (payload) => {
      setPreview(payload);
    },
    onError: (error) => {
      toast.error('Preview failed', getErrorMessage(error));
    },
  });

  return (
    <div className="page-stack brand-voice-page">
      <PageHeader
        title="Brand Voice"
        description="Operator controls for the brand-voice profile and classifier preview."
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
              <div className="empty-state">Loading brand voice...</div>
            ) : profileQuery.isError ? (
              <div className="empty-state">
                {getErrorMessage(profileQuery.error)}
              </div>
            ) : (
              <div className="stack-form">
                <BooleanField
                  label="Enabled"
                  value={profile.enabled}
                  onChange={(enabled) =>
                    setProfile((current) => ({ ...current, enabled }))
                  }
                />
                <div className="field">
                  <span>Mode</span>
                  <SegmentedToggle
                    ariaLabel="Brand voice mode"
                    value={profile.mode}
                    options={[
                      { value: 'rewrite', label: 'rewrite' },
                      { value: 'block', label: 'block' },
                      { value: 'flag', label: 'flag' },
                    ]}
                    onChange={(mode) =>
                      setProfile((current) => ({
                        ...current,
                        mode: mode as AdminBrandVoiceProfile['mode'],
                      }))
                    }
                  />
                </div>
                <div className="field">
                  <span>Classifier</span>
                  <SegmentedToggle
                    ariaLabel="Brand voice classifier provider"
                    value={profile.classifier.provider}
                    options={[
                      { value: 'rules', label: 'rules only' },
                      { value: 'default', label: 'default model' },
                      { value: 'auxiliary', label: 'aux model' },
                    ]}
                    onChange={(provider) =>
                      setProfile((current) => {
                        const nextProvider =
                          provider as AdminBrandVoiceClassifierConfig['provider'];
                        return {
                          ...current,
                          classifier: classifierDefaults(nextProvider),
                        };
                      })
                    }
                  />
                </div>
                <label className="field textarea-field">
                  <span>Voice</span>
                  <textarea
                    rows={5}
                    value={profile.voice}
                    onChange={(event) =>
                      setProfile((current) => ({
                        ...current,
                        voice: event.target.value,
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
                <small className="brand-voice-list-note">
                  Do and Don't guide rewrites; preview scores banned and
                  required rules.
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
                <div className="brand-voice-score-panel">
                  <div className="brand-voice-score-bar">
                    <span style={{ width: `${preview.score}%` }} />
                  </div>
                  <small>{formatClassifierStatus(preview)}</small>
                  {preview.violations.length > 0 ? (
                    <ul className="brand-voice-reason-list">
                      {preview.violations.map((violation) => {
                        const reason = formatPreviewViolation(violation);
                        return <li key={reason}>{reason}</li>;
                      })}
                    </ul>
                  ) : (
                    <small>No rule violations detected.</small>
                  )}
                  {preview.classifier.reasons.length > 0 ? (
                    <ul className="brand-voice-reason-list">
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
