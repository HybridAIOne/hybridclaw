import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import {
  fetchBrandVoiceProfile,
  previewBrandVoiceProfile,
  saveBrandVoiceProfile,
} from '../api/client';
import type {
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
};

function profilesEqual(
  left: AdminBrandVoiceProfile,
  right: AdminBrandVoiceProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateListValue(
  list: string[],
  index: number,
  value: string,
): string[] {
  return list.map((entry, currentIndex) =>
    currentIndex === index ? value : entry,
  );
}

function removeListValue(list: string[], index: number): string[] {
  return list.filter((_, currentIndex) => currentIndex !== index);
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
  };
}

function ListEditor(props: {
  label: string;
  values: string[];
  placeholder: string;
  onChange: (values: string[]) => void;
}) {
  const rowIds = useRef<string[]>([]);
  const nextId = useRef(0);
  while (rowIds.current.length < props.values.length) {
    rowIds.current.push(`${props.label}-${nextId.current}`);
    nextId.current += 1;
  }
  if (rowIds.current.length > props.values.length) {
    rowIds.current.length = props.values.length;
  }

  return (
    <div className="field brand-voice-list-field">
      <span>{props.label}</span>
      <div className="brand-voice-list">
        {props.values.map((value, index) => (
          <div className="brand-voice-list-row" key={rowIds.current[index]}>
            <input
              aria-label={`${props.label} item ${index + 1}`}
              value={value}
              onChange={(event) =>
                props.onChange(
                  updateListValue(props.values, index, event.target.value),
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
                rowIds.current.splice(index, 1);
                props.onChange(removeListValue(props.values, index));
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
            rowIds.current.push(`${props.label}-${nextId.current}`);
            nextId.current += 1;
            props.onChange([...props.values, '']);
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
            <CardDescription>
              {profileQuery.data?.configPath || 'Runtime config'}
            </CardDescription>
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
                  ? `${preview.score}/100, ${formatVerdict(preview.verdict)}`
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
                  {preview.reasons.length > 0 ? (
                    <ul className="brand-voice-reason-list">
                      {preview.reasons.map((reason) => (
                        <li key={reason}>{reason}</li>
                      ))}
                    </ul>
                  ) : (
                    <small>No rule violations detected.</small>
                  )}
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
