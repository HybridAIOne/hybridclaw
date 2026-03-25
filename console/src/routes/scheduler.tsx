import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  deleteSchedulerJob,
  fetchScheduler,
  saveSchedulerJob,
  setSchedulerJobPaused,
} from '../api/client';
import type { AdminSchedulerJob, AdminSchedulerResponse } from '../api/types';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanField,
  BooleanPill,
  Button,
  EmptyState,
  FormField,
  KeyValueGrid,
  KeyValueItem,
  PageHeader,
  Panel,
  SelectableRow,
} from '../components/ui';
import { formatDateTime } from '../lib/format';

interface SchedulerDraft {
  originalId: string | null;
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scheduleKind: 'cron' | 'every' | 'at';
  scheduleExpr: string;
  scheduleEveryMs: string;
  scheduleAt: string;
  scheduleTz: string;
  actionKind: 'agent_turn' | 'system_event';
  actionMessage: string;
  deliveryKind: 'channel' | 'last-channel' | 'webhook';
  deliveryChannel: string;
  deliveryTo: string;
  deliveryWebhookUrl: string;
}

function isConfigJob(
  job: AdminSchedulerJob | null | undefined,
): job is AdminSchedulerJob & { source: 'config' } {
  return job?.source === 'config';
}

function isTaskJob(
  job: AdminSchedulerJob | null | undefined,
): job is AdminSchedulerJob & { source: 'task' } {
  return job?.source === 'task';
}

function toDateTimeLocal(raw: string | null): string {
  if (!raw) return '';
  const value = new Date(raw);
  if (Number.isNaN(value.getTime())) return '';
  const offsetMs = value.getTimezoneOffset() * 60_000;
  return new Date(value.getTime() - offsetMs).toISOString().slice(0, 16);
}

function formatSchedule(job: AdminSchedulerJob): string {
  if (job.schedule.kind === 'cron') {
    return job.schedule.expr || 'invalid cron';
  }
  if (job.schedule.kind === 'every') {
    return `every ${job.schedule.everyMs}ms`;
  }
  return formatDateTime(job.schedule.at);
}

function formatRowMeta(job: AdminSchedulerJob): string {
  if (job.source === 'task') {
    return `task #${job.taskId ?? 'n/a'} · ${formatSchedule(job)}`;
  }
  return `${job.id} · ${formatSchedule(job)}`;
}

function formatRuntimeState(job: AdminSchedulerJob): string {
  if (job.disabled) return 'paused';
  if (job.lastStatus) return job.lastStatus;
  return job.enabled ? 'ready' : 'inactive';
}

function createDraft(source?: AdminSchedulerJob): SchedulerDraft {
  return {
    originalId: source?.id || null,
    id: source?.id || '',
    name: source?.name || '',
    description: source?.description || '',
    enabled: source?.enabled ?? true,
    scheduleKind: source?.schedule.kind || 'cron',
    scheduleExpr: source?.schedule.expr || '0 * * * *',
    scheduleEveryMs:
      source?.schedule.everyMs == null
        ? '60000'
        : String(source.schedule.everyMs),
    scheduleAt: toDateTimeLocal(source?.schedule.at || null),
    scheduleTz: source?.schedule.tz || '',
    actionKind: source?.action.kind || 'agent_turn',
    actionMessage: source?.action.message || '',
    deliveryKind: source?.delivery.kind || 'channel',
    deliveryChannel: source?.delivery.channel || 'discord',
    deliveryTo: source?.delivery.to || '',
    deliveryWebhookUrl: source?.delivery.webhookUrl || '',
  };
}

function normalizeDraft(draft: SchedulerDraft): AdminSchedulerJob {
  return {
    id: draft.id.trim(),
    source: 'config',
    name: draft.name.trim() || draft.id.trim(),
    description: draft.description.trim() || null,
    enabled: draft.enabled,
    schedule: {
      kind: draft.scheduleKind,
      at:
        draft.scheduleKind === 'at' && draft.scheduleAt
          ? new Date(draft.scheduleAt).toISOString()
          : null,
      everyMs:
        draft.scheduleKind === 'every'
          ? Number.parseInt(draft.scheduleEveryMs, 10) || 0
          : null,
      expr:
        draft.scheduleKind === 'cron'
          ? draft.scheduleExpr.trim() || null
          : null,
      tz: draft.scheduleTz.trim(),
    },
    action: {
      kind: draft.actionKind,
      message: draft.actionMessage.trim(),
    },
    delivery: {
      kind: draft.deliveryKind,
      channel: draft.deliveryChannel.trim() || 'discord',
      to: draft.deliveryKind === 'channel' ? draft.deliveryTo.trim() : '',
      webhookUrl:
        draft.deliveryKind === 'webhook' ? draft.deliveryWebhookUrl.trim() : '',
    },
    lastRun: null,
    lastStatus: null,
    nextRunAt: null,
    disabled: false,
    consecutiveErrors: 0,
    createdAt: null,
    sessionId: null,
    channelId: null,
    taskId: null,
  };
}

function replaceSchedulerJobs(
  payload: AdminSchedulerResponse,
  token: string,
  queryClient: ReturnType<typeof useQueryClient>,
): void {
  queryClient.setQueryData(['scheduler', token], payload);
}

function SchedulerTaskDetail(props: {
  job: AdminSchedulerJob & { source: 'task' };
  pausePending: boolean;
  deletePending: boolean;
  onPauseToggle: () => void;
  onDelete: () => void;
  pauseError: Error | null;
  deleteError: Error | null;
}) {
  return (
    <Panel title="Task" accent="warm">
      <div className="stack-form">
        <KeyValueGrid>
          <KeyValueItem
            label="Task"
            value={`#${props.job.taskId ?? 'n/a'}`}
          />
          <KeyValueItem
            label="State"
            value={
              <BooleanPill
                value={props.job.enabled && !props.job.disabled}
                trueLabel="active"
                falseLabel="inactive"
              />
            }
          />
          <KeyValueItem
            label="Session"
            value={props.job.sessionId || 'n/a'}
          />
          <KeyValueItem
            label="Channel"
            value={props.job.channelId || 'n/a'}
          />
          <KeyValueItem
            label="Created"
            value={formatDateTime(props.job.createdAt)}
          />
          <KeyValueItem
            label="Next run"
            value={formatDateTime(props.job.nextRunAt)}
          />
          <KeyValueItem
            label="Last run"
            value={formatDateTime(props.job.lastRun)}
          />
          <KeyValueItem
            label="Last status"
            value={props.job.lastStatus || 'n/a'}
          />
        </KeyValueGrid>

        <FormField label="Message">
          <textarea readOnly rows={6} value={props.job.action.message} />
        </FormField>

        <div className="button-row">
          <Button
            variant="ghost"
            disabled={props.pausePending}
            onClick={props.onPauseToggle}
          >
            {props.pausePending
              ? 'Updating...'
              : props.job.disabled
                ? 'Resume task'
                : 'Pause task'}
          </Button>
          <Button
            variant="danger"
            disabled={props.deletePending}
            onClick={props.onDelete}
          >
            {props.deletePending ? 'Deleting...' : 'Delete task'}
          </Button>
        </div>

        {props.pauseError ? (
          <Banner variant="error">{props.pauseError.message}</Banner>
        ) : null}
        {props.deleteError ? (
          <Banner variant="error">{props.deleteError.message}</Banner>
        ) : null}
      </div>
    </Panel>
  );
}

function SchedulerJobEditor(props: {
  draft: SchedulerDraft;
  selectedJob: (AdminSchedulerJob & { source: 'config' }) | null;
  savePending: boolean;
  pausePending: boolean;
  deletePending: boolean;
  saveError: Error | null;
  pauseError: Error | null;
  deleteError: Error | null;
  saveResult: AdminSchedulerResponse | undefined;
  onDraftChange: (update: (current: SchedulerDraft) => SchedulerDraft) => void;
  onSave: () => void;
  onPauseToggle: () => void;
  onDelete: () => void;
}) {
  const { draft, selectedJob } = props;

  return (
    <Panel title="Job" accent="warm">
      <div className="stack-form">
        <div className="field-grid">
          <FormField label="ID">
            <input
              value={draft.id}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  id: event.target.value,
                }))
              }
              placeholder="nightly-research"
            />
          </FormField>
          <FormField label="Name">
            <input
              value={draft.name}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  name: event.target.value,
                }))
              }
              placeholder="Nightly research"
            />
          </FormField>
        </div>

        <FormField label="Description">
          <input
            value={draft.description}
            onChange={(event) =>
              props.onDraftChange((current) => ({
                ...current,
                description: event.target.value,
              }))
            }
            placeholder="Optional"
          />
        </FormField>

        <BooleanField
          label="State"
          value={draft.enabled}
          trueLabel="on"
          falseLabel="off"
          onChange={(enabled) =>
            props.onDraftChange((current) => ({
              ...current,
              enabled,
            }))
          }
        />

        <div className="field-grid">
          <FormField label="Schedule">
            <select
              value={draft.scheduleKind}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleKind: event.target
                    .value as SchedulerDraft['scheduleKind'],
                }))
              }
            >
              <option value="cron">cron</option>
              <option value="every">every</option>
              <option value="at">at</option>
            </select>
          </FormField>
          <FormField label="Timezone">
            <input
              value={draft.scheduleTz}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleTz: event.target.value,
                }))
              }
              placeholder="Europe/Berlin"
            />
          </FormField>
        </div>

        {draft.scheduleKind === 'cron' ? (
          <FormField label="Cron">
            <input
              value={draft.scheduleExpr}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleExpr: event.target.value,
                }))
              }
              placeholder="0 * * * *"
            />
          </FormField>
        ) : null}

        {draft.scheduleKind === 'every' ? (
          <FormField label="Every ms">
            <input
              value={draft.scheduleEveryMs}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleEveryMs: event.target.value,
                }))
              }
              placeholder="60000"
            />
          </FormField>
        ) : null}

        {draft.scheduleKind === 'at' ? (
          <FormField label="Run at">
            <input
              type="datetime-local"
              value={draft.scheduleAt}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleAt: event.target.value,
                }))
              }
            />
          </FormField>
        ) : null}

        <div className="field-grid">
          <FormField label="Action">
            <select
              value={draft.actionKind}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  actionKind: event.target
                    .value as SchedulerDraft['actionKind'],
                }))
              }
            >
              <option value="agent_turn">agent_turn</option>
              <option value="system_event">system_event</option>
            </select>
          </FormField>
          <FormField label="Delivery">
            <select
              value={draft.deliveryKind}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  deliveryKind: event.target
                    .value as SchedulerDraft['deliveryKind'],
                }))
              }
            >
              <option value="channel">channel</option>
              <option value="last-channel">last-channel</option>
              <option value="webhook">webhook</option>
            </select>
          </FormField>
        </div>

        <FormField label="Message">
          <textarea
            rows={4}
            value={draft.actionMessage}
            onChange={(event) =>
              props.onDraftChange((current) => ({
                ...current,
                actionMessage: event.target.value,
              }))
            }
            placeholder="Prompt or system-event message"
          />
        </FormField>

        {draft.deliveryKind === 'channel' ? (
          <div className="field-grid">
            <FormField label="Channel type">
              <input
                value={draft.deliveryChannel}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    deliveryChannel: event.target.value,
                  }))
                }
                placeholder="discord"
              />
            </FormField>
            <FormField label="Channel ID">
              <input
                value={draft.deliveryTo}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    deliveryTo: event.target.value,
                  }))
                }
                placeholder="1234567890"
              />
            </FormField>
          </div>
        ) : null}

        {draft.deliveryKind === 'webhook' ? (
          <FormField label="Webhook URL">
            <input
              value={draft.deliveryWebhookUrl}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  deliveryWebhookUrl: event.target.value,
                }))
              }
              placeholder="https://example.test/hook"
            />
          </FormField>
        ) : null}

        {selectedJob ? (
          <KeyValueGrid>
            <KeyValueItem
              label="Next run"
              value={formatDateTime(selectedJob.nextRunAt)}
            />
            <KeyValueItem
              label="Last run"
              value={formatDateTime(selectedJob.lastRun)}
            />
            <KeyValueItem
              label="Last status"
              value={selectedJob.lastStatus || 'n/a'}
            />
            <KeyValueItem
              label="Errors"
              value={selectedJob.consecutiveErrors}
            />
          </KeyValueGrid>
        ) : null}

        <div className="button-row">
          <Button
            variant="primary"
            disabled={props.savePending}
            onClick={props.onSave}
          >
            {props.savePending ? 'Saving...' : 'Save job'}
          </Button>
          {selectedJob ? (
            <Button
              variant="ghost"
              disabled={props.pausePending}
              onClick={props.onPauseToggle}
            >
              {props.pausePending
                ? 'Updating...'
                : selectedJob.disabled
                  ? 'Resume job'
                  : 'Pause job'}
            </Button>
          ) : null}
          {selectedJob ? (
            <Button
              variant="danger"
              disabled={props.deletePending}
              onClick={props.onDelete}
            >
              {props.deletePending ? 'Deleting...' : 'Delete job'}
            </Button>
          ) : null}
        </div>

        {props.saveResult ? (
          <Banner variant="success">
            Saved{' '}
            {props.saveResult.jobs.find((job) => job.id === draft.id)?.name ||
              draft.id}
            .
          </Banner>
        ) : null}
        {props.saveError ? (
          <Banner variant="error">{props.saveError.message}</Banner>
        ) : null}
        {props.pauseError ? (
          <Banner variant="error">{props.pauseError.message}</Banner>
        ) : null}
        {props.deleteError ? (
          <Banner variant="error">{props.deleteError.message}</Banner>
        ) : null}
      </div>
    </Panel>
  );
}

export function SchedulerPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SchedulerDraft>(createDraft());

  const schedulerQuery = useQuery({
    queryKey: ['scheduler', auth.token],
    queryFn: () => fetchScheduler(auth.token),
  });

  const selectedJob =
    schedulerQuery.data?.jobs.find((job) => job.id === selectedId) || null;
  const selectedConfigJob = isConfigJob(selectedJob) ? selectedJob : null;

  const saveMutation = useMutation({
    mutationFn: () => saveSchedulerJob(auth.token, normalizeDraft(draft)),
    onSuccess: (payload) => {
      replaceSchedulerJobs(payload, auth.token, queryClient);
      setSelectedId(draft.id.trim());
      const refreshed = payload.jobs.find((job) => job.id === draft.id.trim());
      if (isConfigJob(refreshed)) {
        setDraft(createDraft(refreshed));
      }
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!selectedJob) {
        throw new Error('Select a scheduler item first.');
      }
      return deleteSchedulerJob(auth.token, selectedJob);
    },
    onSuccess: (payload) => {
      replaceSchedulerJobs(payload, auth.token, queryClient);
      setSelectedId(null);
      setDraft(createDraft());
    },
  });

  const pauseMutation = useMutation({
    mutationFn: (action: 'pause' | 'resume') => {
      if (!selectedJob) {
        throw new Error('Select a scheduler item first.');
      }
      return selectedJob.source === 'task'
        ? setSchedulerJobPaused(auth.token, {
            source: 'task',
            taskId: selectedJob.taskId ?? 0,
            action,
          })
        : setSchedulerJobPaused(auth.token, {
            source: 'config',
            jobId: selectedJob.id,
            action,
          });
    },
    onSuccess: (payload) => {
      replaceSchedulerJobs(payload, auth.token, queryClient);
      if (!selectedJob) return;
      const refreshed =
        payload.jobs.find((job) => job.id === selectedJob.id) || null;
      if (!refreshed) {
        setSelectedId(null);
        setDraft(createDraft());
        return;
      }
      if (isConfigJob(refreshed)) {
        setDraft(createDraft(refreshed));
      }
    },
  });

  useEffect(() => {
    if (selectedConfigJob) {
      setDraft(createDraft(selectedConfigJob));
      return;
    }
    if (!selectedId) {
      setDraft(createDraft());
    }
  }, [selectedConfigJob, selectedId]);

  useEffect(() => {
    if (!selectedId || schedulerQuery.isLoading) return;
    if (selectedJob) return;
    setSelectedId(null);
  }, [schedulerQuery.isLoading, selectedId, selectedJob]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Scheduler"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedId(null);
              setDraft(createDraft());
            }}
          >
            New job
          </Button>
        }
      />

      <div className="two-column-grid">
        <Panel
          title="Jobs"
          subtitle={`${schedulerQuery.data?.jobs.length || 0} item${schedulerQuery.data?.jobs.length === 1 ? '' : 's'}`}
        >
          {schedulerQuery.isLoading ? (
            <EmptyState>Loading scheduler items...</EmptyState>
          ) : schedulerQuery.data?.jobs.length ? (
            <div className="list-stack selectable-list">
              {schedulerQuery.data.jobs.map((job) => (
                <SelectableRow
                  key={job.id}
                  active={job.id === selectedId}
                  onClick={() => setSelectedId(job.id)}
                >
                  <div>
                    <strong>{job.name}</strong>
                    <small>{formatRowMeta(job)}</small>
                  </div>
                  <div className="row-status-stack">
                    <BooleanPill
                      value={job.enabled && !job.disabled}
                      trueLabel="active"
                      falseLabel="inactive"
                    />
                    <small>{formatRuntimeState(job)}</small>
                  </div>
                </SelectableRow>
              ))}
            </div>
          ) : (
            <EmptyState>No scheduled work yet.</EmptyState>
          )}
        </Panel>

        {isTaskJob(selectedJob) ? (
          <SchedulerTaskDetail
            job={selectedJob}
            pausePending={pauseMutation.isPending}
            deletePending={deleteMutation.isPending}
            onPauseToggle={() =>
              pauseMutation.mutate(selectedJob.disabled ? 'resume' : 'pause')
            }
            onDelete={() => deleteMutation.mutate()}
            pauseError={pauseMutation.error as Error | null}
            deleteError={deleteMutation.error as Error | null}
          />
        ) : (
          <SchedulerJobEditor
            draft={draft}
            selectedJob={selectedConfigJob}
            savePending={saveMutation.isPending}
            pausePending={pauseMutation.isPending}
            deletePending={deleteMutation.isPending}
            saveError={saveMutation.error as Error | null}
            pauseError={pauseMutation.error as Error | null}
            deleteError={deleteMutation.error as Error | null}
            saveResult={saveMutation.isSuccess ? saveMutation.data : undefined}
            onDraftChange={(update) => setDraft((current) => update(current))}
            onSave={() => saveMutation.mutate()}
            onPauseToggle={() =>
              pauseMutation.mutate(
                selectedConfigJob?.disabled ? 'resume' : 'pause',
              )
            }
            onDelete={() => deleteMutation.mutate()}
          />
        )}
      </div>
    </div>
  );
}
