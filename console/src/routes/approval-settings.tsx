/**
 * Operators explicitly save a new-session default or one conversation's mode.
 * Drafts retain the observed value for stale-edit protection. This page does
 * not bulk-change sessions or answer the pending approvals shown under policy.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  APPROVAL_MODE_PRESENTATION,
  APPROVAL_MODES,
  type ApprovalMode,
  type ApprovalSettingsUpdate,
  isApprovalMode,
} from '../../../container/shared/approval-mode.js';
import {
  fetchApprovalSettings,
  saveApprovalSettings,
} from '../api/approval-settings';
import { useAuth } from '../auth';
import { Button } from '../components/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/card';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { useUnsavedChangesGuard } from '../hooks/use-unsaved-changes-guard';
import styles from './approval-settings.module.css';

function ModeEditor(props: {
  title: string;
  description: string;
  mode: ApprovalMode;
  effectiveMode?: ApprovalMode;
  onDirtyChange?: (dirty: boolean) => void;
  target: { target: 'default' } | { target: 'session'; sessionId: string };
}) {
  const auth = useAuth();
  const client = useQueryClient();
  const [draft, setDraft] = useState<{
    before: ApprovalMode;
    mode: ApprovalMode;
  } | null>(null);
  const [saved, setSaved] = useState(false);
  const mode = draft?.mode ?? props.mode;
  const dirty = draft !== null && draft.mode !== draft.before;
  const { dialog } = useUnsavedChangesGuard({
    isDirty: dirty,
    includeSearch: true,
  });
  useEffect(() => {
    props.onDirtyChange?.(dirty);
  }, [dirty, props.onDirtyChange]);
  const save = useMutation({
    mutationFn: (body: ApprovalSettingsUpdate) =>
      saveApprovalSettings(auth.token, body),
    onSuccess: (data) => {
      client.setQueryData(['approval-settings', auth.token], data);
      void client.invalidateQueries({ queryKey: ['chat-context'] });
      void client.invalidateQueries({ queryKey: ['config'] });
      setDraft(null);
      setSaved(true);
    },
  });
  return (
    <Card>
      {dialog}
      <CardHeader>
        <CardTitle>{props.title}</CardTitle>
      </CardHeader>
      <CardContent className={styles.content}>
        <p className="supporting-text">{props.description}</p>
        <NativeSelect
          aria-label={props.title}
          value={mode}
          disabled={save.isPending}
          onChange={(event) => {
            if (isApprovalMode(event.target.value)) {
              setSaved(false);
              setDraft({
                before: draft?.before ?? props.mode,
                mode: event.target.value,
              });
            }
          }}
        >
          {APPROVAL_MODES.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {APPROVAL_MODE_PRESENTATION[value].label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <p>{APPROVAL_MODE_PRESENTATION[mode].description}</p>
        {props.effectiveMode && props.effectiveMode !== props.mode && (
          <p role="status">
            Full-auto currently uses{' '}
            {APPROVAL_MODE_PRESENTATION[props.effectiveMode].label}. Selecting
            Learning also applies during full-auto; other saved modes take
            effect after full-auto stops.
          </p>
        )}
        {save.error && <p role="alert">{save.error.message}</p>}
        {saved && <p role="status">Saved.</p>}
        <div className="header-actions">
          <Button
            disabled={!dirty || save.isPending}
            onClick={() =>
              draft &&
              save.mutate({
                ...props.target,
                mode: draft.mode,
                expectedMode: draft.before,
              })
            }
          >
            Save{' '}
            {props.target.target === 'default'
              ? 'default'
              : 'conversation mode'}
          </Button>
          <Button
            variant="outline"
            disabled={save.isPending}
            onClick={() => {
              setDraft(null);
              setSaved(false);
              save.reset();
              void client.invalidateQueries({
                queryKey: ['approval-settings', auth.token],
              });
            }}
          >
            Reload
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export function ApprovalSettingsPage() {
  const auth = useAuth();
  const query = useQuery({
    queryKey: ['approval-settings', auth.token],
    queryFn: () => fetchApprovalSettings(auth.token),
  });
  const [sessionId, setSessionId] = useState('');
  const [sessionDirty, setSessionDirty] = useState(false);
  const session = query.data?.sessions.find((entry) => entry.id === sessionId);
  return (
    <div className="page-stack">
      <p>
        Choose how actions are approved. Learning runs flagged actions and
        records what would have required approval. Enabled safety blocks remain
        enforced in every mode.
      </p>
      <a href="/admin/audit?q=type%3Aapproval.observed">
        Review learning flags
      </a>
      {query.isLoading && <p>Loading approval settings…</p>}
      {query.error && <p role="alert">{query.error.message}</p>}
      {query.data && (
        <>
          <ModeEditor
            title="Default for new conversations"
            description="Applies to conversations created after saving and to an explicit settings reset. Existing conversations keep their stored mode; forks and ordinary resets preserve it."
            mode={query.data.defaultMode}
            target={{ target: 'default' }}
          />
          <Card>
            <CardHeader>
              <CardTitle>Existing conversation</CardTitle>
            </CardHeader>
            <CardContent>
              <NativeSelect
                aria-label="Conversation"
                disabled={sessionDirty}
                value={sessionId}
                onChange={(event) => setSessionId(event.target.value)}
              >
                <NativeSelectOption value="">
                  Choose a conversation…
                </NativeSelectOption>
                {query.data.sessions.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.agentId} · {entry.channelId} · {entry.id}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
              {!query.data.sessions.length && <p>No conversations yet.</p>}
            </CardContent>
          </Card>
          {session && (
            <ModeEditor
              key={session.id}
              onDirtyChange={setSessionDirty}
              title="Conversation approval mode"
              description="Changes this conversation from its next turn, using the same stored mode as /approvals mode. This does not answer an already pending approval."
              mode={session.storedMode}
              effectiveMode={session.effectiveMode}
              target={{ target: 'session', sessionId: session.id }}
            />
          )}
        </>
      )}
    </div>
  );
}
