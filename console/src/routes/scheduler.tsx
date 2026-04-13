import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  deleteSchedulerJob,
  fetchChannels,
  fetchConfig,
  fetchScheduler,
  saveSchedulerJob,
  setSchedulerJobPaused,
} from '../api/client';
import type {
  AdminChannelsResponse,
  AdminConfig,
  AdminSchedulerJob,
  AdminSchedulerResponse,
  GatewayStatus,
} from '../api/types';
import { useAuth } from '../auth';
import { useToast } from '../components/toast';
import { BooleanField, BooleanPill, PageHeader, Panel } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';
import { buildChannelCatalog } from './channels-catalog';

interface SchedulerDraft {
  originalId: string | null;
  id: string;
  name: string;
  description: string;
  agentId: string;
  boardStatus: 'backlog' | 'in_progress' | 'review' | 'done' | 'cancelled';
  enabled: boolean;
  scheduleKind: 'cron' | 'every' | 'at' | 'one_shot';
  scheduleExpr: string;
  scheduleEveryMs: string;
  scheduleAt: string;
  scheduleTz: string;
  maxRetries: string;
  actionKind: 'agent_turn' | 'system_event';
  actionMessage: string;
  deliveryKind: 'channel' | 'last-channel' | 'webhook';
  deliveryChannel: string;
  deliveryTo: string;
  deliveryWebhookUrl: string;
}

type SchedulerChannelOption = {
  value: string;
  label: string;
};

type SchedulerTargetOption = {
  value: string;
  label: string;
};

type SchedulerTargetControl =
  | {
      kind: 'none';
      value: string;
    }
  | {
      kind: 'input';
      value: string;
      label: string;
      placeholder: string;
    }
  | {
      kind: 'select';
      value: string;
      label: string;
      options: SchedulerTargetOption[];
    };

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
  if (job.schedule.kind === 'one_shot') {
    return 'one shot';
  }
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
  if (job.boardStatus === 'review' && job.lastStatus === 'error') {
    return 'failed';
  }
  if (job.lastStatus) return job.lastStatus;
  return job.enabled ? 'ready' : 'inactive';
}

function deriveDraftBoardStatus(
  job: AdminSchedulerJob | undefined,
): SchedulerDraft['boardStatus'] {
  if (job?.boardStatus) return job.boardStatus;
  if (!job) return 'backlog';
  if (!job.enabled || job.disabled) return 'cancelled';
  if (job.lastStatus === 'success') return 'done';
  if (job.lastStatus === 'error') return 'cancelled';
  return 'backlog';
}

function createDraft(source?: AdminSchedulerJob): SchedulerDraft {
  return {
    originalId: source?.id || null,
    id: source?.id || '',
    name: source?.name || '',
    description: source?.description || '',
    agentId: source?.agentId || '',
    boardStatus: deriveDraftBoardStatus(source),
    enabled: source?.enabled ?? true,
    scheduleKind: source?.schedule.kind || 'cron',
    scheduleExpr: source?.schedule.expr || '0 * * * *',
    scheduleEveryMs:
      source?.schedule.everyMs == null
        ? '60000'
        : String(source.schedule.everyMs),
    scheduleAt: toDateTimeLocal(source?.schedule.at || null),
    scheduleTz: source?.schedule.tz || '',
    maxRetries:
      typeof source?.maxRetries === 'number' ? String(source.maxRetries) : '3',
    actionKind: source?.action.kind || 'agent_turn',
    actionMessage: source?.action.message || '',
    deliveryKind: source?.delivery.kind || 'channel',
    deliveryChannel: source?.delivery.channel || 'tui',
    deliveryTo: source?.delivery.to || '',
    deliveryWebhookUrl: source?.delivery.webhookUrl || '',
  };
}

function buildSchedulerChannelOptions(params: {
  config?: AdminConfig;
  status?: GatewayStatus | null;
  currentChannel: string;
}): SchedulerChannelOption[] {
  const options: SchedulerChannelOption[] = [
    {
      value: 'tui',
      label: 'Local TUI',
    },
  ];
  const config = params.config;
  if (config) {
    const catalog = buildChannelCatalog(config, {
      discordTokenConfigured: params.status?.discord?.tokenConfigured,
      slackBotTokenConfigured: params.status?.slack?.botTokenConfigured,
      slackAppTokenConfigured: params.status?.slack?.appTokenConfigured,
      telegramTokenConfigured: params.status?.telegram?.tokenConfigured,
      whatsappLinked: params.status?.whatsapp?.linked,
      emailPasswordConfigured: params.status?.email?.passwordConfigured,
      imessagePasswordConfigured: params.status?.imessage?.passwordConfigured,
    });
    for (const item of catalog) {
      if (item.statusTone !== 'active') continue;
      options.push({
        value: item.kind,
        label: item.label,
      });
    }
  }

  const currentChannel = params.currentChannel.trim();
  if (
    currentChannel &&
    !options.some((option) => option.value === currentChannel)
  ) {
    options.push({
      value: currentChannel,
      label: `${formatSchedulerChannelLabel(currentChannel)} (current)`,
    });
  }

  return options;
}

function formatSchedulerChannelLabel(channel: string): string {
  switch (channel) {
    case 'discord':
      return 'Discord';
    case 'slack':
      return 'Slack';
    case 'telegram':
      return 'Telegram';
    case 'whatsapp':
      return 'WhatsApp';
    case 'email':
      return 'Email';
    case 'msteams':
      return 'Microsoft Teams';
    case 'imessage':
      return 'iMessage';
    case 'tui':
      return 'Local TUI';
    case 'web':
      return 'Local Web';
    default:
      return channel;
  }
}

function buildConfiguredTargetOptions(
  channel: string,
  channels: AdminChannelsResponse | undefined,
): SchedulerTargetOption[] {
  if (!channels) return [];
  if (channel === 'discord') {
    return channels.channels
      .filter((entry) => entry.transport === 'discord')
      .map((entry) => ({
        value: entry.channelId,
        label: `${entry.guildId} · ${entry.channelId}`,
      }));
  }
  if (channel === 'msteams') {
    return channels.channels
      .filter((entry) => entry.transport === 'msteams')
      .map((entry) => ({
        value: entry.channelId,
        label: `${entry.guildId} · ${entry.channelId}`,
      }));
  }
  return [];
}

function resolveSchedulerTargetValue(params: {
  channel: string;
  currentValue: string;
  options: SchedulerTargetOption[];
}): string {
  const currentValue = params.currentValue.trim();
  if (params.channel === 'tui' || params.channel === 'web') {
    return params.channel;
  }
  if (params.options.length === 0) {
    return currentValue;
  }
  if (params.options.some((option) => option.value === currentValue)) {
    return currentValue;
  }
  return params.options[0].value;
}

function buildSchedulerTargetControl(params: {
  channel: string;
  currentValue: string;
  channels: AdminChannelsResponse | undefined;
}): SchedulerTargetControl {
  const options = buildConfiguredTargetOptions(params.channel, params.channels);
  const value = resolveSchedulerTargetValue({
    channel: params.channel,
    currentValue: params.currentValue,
    options,
  });

  if (params.channel === 'tui' || params.channel === 'web') {
    return {
      kind: 'none',
      value,
    };
  }
  if (
    (params.channel === 'discord' || params.channel === 'msteams') &&
    options.length === 1
  ) {
    return {
      kind: 'none',
      value,
    };
  }
  if (
    (params.channel === 'discord' || params.channel === 'msteams') &&
    options.length > 1
  ) {
    return {
      kind: 'select',
      value,
      label: 'Channel',
      options,
    };
  }

  switch (params.channel) {
    case 'discord':
      return {
        kind: 'input',
        value,
        label: 'Channel ID',
        placeholder: '123456789012345678',
      };
    case 'slack':
      return {
        kind: 'input',
        value,
        label: 'Conversation target',
        placeholder: 'slack:C1234567890',
      };
    case 'telegram':
      return {
        kind: 'input',
        value,
        label: 'Chat ID',
        placeholder: 'telegram:-1001234567890',
      };
    case 'whatsapp':
      return {
        kind: 'input',
        value,
        label: 'Chat JID',
        placeholder: '491234567890@s.whatsapp.net',
      };
    case 'email':
      return {
        kind: 'input',
        value,
        label: 'Recipient',
        placeholder: 'ops@example.com',
      };
    case 'imessage':
      return {
        kind: 'input',
        value,
        label: 'Handle',
        placeholder: 'imessage:ops@example.com',
      };
    case 'msteams':
      return {
        kind: 'input',
        value,
        label: 'Channel ID',
        placeholder: '19:channel-id@thread.tacv2',
      };
    default:
      return {
        kind: 'input',
        value,
        label: 'Target',
        placeholder: params.channel || 'target',
      };
  }
}

function applyResolvedTarget(
  draft: SchedulerDraft,
  targetControl: SchedulerTargetControl,
): SchedulerDraft {
  if (draft.deliveryKind !== 'channel') {
    return {
      ...draft,
      deliveryTo: '',
    };
  }
  return {
    ...draft,
    deliveryTo: targetControl.value,
  };
}

function slugifySchedulerId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function prepareDraftForSave(draft: SchedulerDraft): SchedulerDraft {
  const explicitId = draft.id.trim();
  if (explicitId) {
    return {
      ...draft,
      id: explicitId,
    };
  }

  const base =
    slugifySchedulerId(draft.name) ||
    slugifySchedulerId(draft.description) ||
    slugifySchedulerId(draft.actionMessage);
  const generatedId =
    base || `job-${Date.now().toString(36).slice(-8).toLowerCase()}`;

  return {
    ...draft,
    id: generatedId,
  };
}

export function normalizeSchedulerAtInput(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const localDateTimeMatch = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/,
  );
  if (localDateTimeMatch) {
    const [, year, month, day, hour, minute, second = '0'] = localDateTimeMatch;
    const parsed = new Date(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    );
    if (
      parsed.getFullYear() !== Number.parseInt(year, 10) ||
      parsed.getMonth() !== Number.parseInt(month, 10) - 1 ||
      parsed.getDate() !== Number.parseInt(day, 10) ||
      parsed.getHours() !== Number.parseInt(hour, 10) ||
      parsed.getMinutes() !== Number.parseInt(minute, 10) ||
      parsed.getSeconds() !== Number.parseInt(second, 10)
    ) {
      return null;
    }
    return parsed.toISOString();
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

function normalizeDraft(draft: SchedulerDraft): AdminSchedulerJob {
  const at =
    draft.scheduleKind === 'at'
      ? normalizeSchedulerAtInput(draft.scheduleAt)
      : null;
  if (draft.scheduleKind === 'at' && !at) {
    throw new Error('Pick a valid "Run at" timestamp.');
  }
  const parsedMaxRetries =
    draft.scheduleKind === 'one_shot'
      ? Number.parseInt(draft.maxRetries, 10)
      : null;
  const maxRetries =
    parsedMaxRetries == null ? null : Math.floor(parsedMaxRetries);
  if (
    draft.scheduleKind === 'one_shot' &&
    (!Number.isFinite(parsedMaxRetries) ||
      maxRetries == null ||
      maxRetries < 0 ||
      maxRetries > 100)
  ) {
    throw new Error('Pick a valid retry count from 0 to 100.');
  }

  return {
    id: draft.id.trim(),
    source: 'config',
    name: draft.name.trim() || draft.id.trim(),
    description: draft.description.trim() || null,
    agentId: draft.agentId.trim() || null,
    boardStatus: draft.boardStatus,
    maxRetries: draft.scheduleKind === 'one_shot' ? maxRetries : null,
    enabled: draft.enabled,
    schedule: {
      kind: draft.scheduleKind,
      at,
      everyMs:
        draft.scheduleKind === 'every'
          ? Number.parseInt(draft.scheduleEveryMs, 10) || 0
          : null,
      expr:
        draft.scheduleKind === 'cron'
          ? draft.scheduleExpr.trim() || null
          : null,
      tz: draft.scheduleKind === 'one_shot' ? '' : draft.scheduleTz.trim(),
    },
    action: {
      kind: draft.actionKind,
      message: draft.actionMessage.trim(),
    },
    delivery: {
      kind: draft.deliveryKind,
      channel: draft.deliveryChannel.trim() || 'tui',
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
}) {
  return (
    <Panel title="Task" accent="warm">
      <div className="stack-form">
        <div className="key-value-grid">
          <div>
            <span>Task</span>
            <strong>#{props.job.taskId ?? 'n/a'}</strong>
          </div>
          <div>
            <span>State</span>
            <BooleanPill
              value={props.job.enabled && !props.job.disabled}
              trueLabel="active"
              falseLabel="inactive"
            />
          </div>
          <div>
            <span>Session</span>
            <strong>{props.job.sessionId || 'n/a'}</strong>
          </div>
          <div>
            <span>Channel</span>
            <strong>{props.job.channelId || 'n/a'}</strong>
          </div>
          <div>
            <span>Created</span>
            <strong>{formatDateTime(props.job.createdAt)}</strong>
          </div>
          <div>
            <span>Next run</span>
            <strong>{formatDateTime(props.job.nextRunAt)}</strong>
          </div>
          <div>
            <span>Last run</span>
            <strong>{formatDateTime(props.job.lastRun)}</strong>
          </div>
          <div>
            <span>Last status</span>
            <strong>{props.job.lastStatus || 'n/a'}</strong>
          </div>
        </div>

        <label className="field">
          <span>Message</span>
          <textarea readOnly rows={6} value={props.job.action.message} />
        </label>

        <div className="button-row">
          <button
            className="ghost-button"
            type="button"
            disabled={props.pausePending}
            onClick={props.onPauseToggle}
          >
            {props.pausePending
              ? 'Updating...'
              : props.job.disabled
                ? 'Resume task'
                : 'Pause task'}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={props.deletePending}
            onClick={props.onDelete}
          >
            {props.deletePending ? 'Deleting...' : 'Delete task'}
          </button>
        </div>
      </div>
    </Panel>
  );
}

function SchedulerJobEditor(props: {
  draft: SchedulerDraft;
  selectedJob: (AdminSchedulerJob & { source: 'config' }) | null;
  channelOptions: SchedulerChannelOption[];
  targetControl: SchedulerTargetControl;
  savePending: boolean;
  pausePending: boolean;
  deletePending: boolean;
  onDraftChange: (update: (current: SchedulerDraft) => SchedulerDraft) => void;
  onSave: () => void;
  onCancel: () => void;
  onPauseToggle: () => void;
  onDelete: () => void;
}) {
  const { draft, selectedJob } = props;

  return (
    <Panel title="Job" accent="warm">
      <div className="stack-form">
        <div className="field-grid">
          <label className="field">
            <span>ID</span>
            <input
              value={draft.id}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  id: event.target.value,
                }))
              }
              placeholder="Auto-generated from name if blank"
            />
          </label>
          <label className="field">
            <span>Name</span>
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
          </label>
        </div>

        <label className="field">
          <span>Description</span>
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
        </label>

        <div className="field-grid">
          <label className="field">
            <span>Status</span>
            <select
              value={draft.boardStatus}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  boardStatus: event.target
                    .value as SchedulerDraft['boardStatus'],
                }))
              }
            >
              <option value="backlog">backlog</option>
              <option value="in_progress">in progress</option>
              <option value="review">review</option>
              <option value="done">done</option>
              <option value="cancelled">cancelled</option>
            </select>
          </label>
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
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Schedule</span>
            <select
              value={draft.scheduleKind}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  scheduleKind: event.target
                    .value as SchedulerDraft['scheduleKind'],
                  boardStatus:
                    event.target.value === 'one_shot'
                      ? 'backlog'
                      : current.boardStatus,
                  maxRetries:
                    event.target.value === 'one_shot'
                      ? current.maxRetries.trim() || '3'
                      : current.maxRetries,
                }))
              }
            >
              <option value="cron">cron</option>
              <option value="every">every</option>
              <option value="at">at</option>
              <option value="one_shot">one shot</option>
            </select>
          </label>
          {draft.scheduleKind !== 'one_shot' ? (
            <label className="field">
              <span>Timezone</span>
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
            </label>
          ) : null}
        </div>

        {draft.scheduleKind === 'cron' ? (
          <label className="field">
            <span>Cron</span>
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
          </label>
        ) : null}

        {draft.scheduleKind === 'every' ? (
          <label className="field">
            <span>Every ms</span>
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
          </label>
        ) : null}

        {draft.scheduleKind === 'at' ? (
          <label className="field">
            <span>Run at</span>
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
          </label>
        ) : null}

        {draft.scheduleKind === 'one_shot' ? (
          <label className="field">
            <span>Retries after failure</span>
            <input
              type="number"
              min="0"
              max="100"
              step="1"
              value={draft.maxRetries}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  maxRetries: event.target.value,
                }))
              }
              placeholder="3"
            />
          </label>
        ) : null}

        <div className="field-grid">
          <label className="field">
            <span>Action</span>
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
          </label>
          <label className="field">
            <span>Delivery</span>
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
          </label>
        </div>

        <label className="field">
          <span>Message</span>
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
        </label>

        {draft.deliveryKind === 'channel' ? (
          <div className="field-grid">
            <label className="field">
              <span>Channel type</span>
              <select
                value={draft.deliveryChannel}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    deliveryChannel: event.target.value,
                    deliveryTo: '',
                  }))
                }
              >
                {props.channelOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            {props.targetControl.kind === 'select' ? (
              <label className="field">
                <span>{props.targetControl.label}</span>
                <select
                  value={props.targetControl.value}
                  onChange={(event) =>
                    props.onDraftChange((current) => ({
                      ...current,
                      deliveryTo: event.target.value,
                    }))
                  }
                >
                  {props.targetControl.options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {props.targetControl.kind === 'input' ? (
              <label className="field">
                <span>{props.targetControl.label}</span>
                <input
                  value={props.targetControl.value}
                  onChange={(event) =>
                    props.onDraftChange((current) => ({
                      ...current,
                      deliveryTo: event.target.value,
                    }))
                  }
                  placeholder={props.targetControl.placeholder}
                />
              </label>
            ) : null}
          </div>
        ) : null}

        {draft.deliveryKind === 'webhook' ? (
          <label className="field">
            <span>Webhook URL</span>
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
          </label>
        ) : null}

        {selectedJob ? (
          <div className="key-value-grid">
            <div>
              <span>Next run</span>
              <strong>{formatDateTime(selectedJob.nextRunAt)}</strong>
            </div>
            <div>
              <span>Last run</span>
              <strong>{formatDateTime(selectedJob.lastRun)}</strong>
            </div>
            <div>
              <span>Last status</span>
              <strong>{selectedJob.lastStatus || 'n/a'}</strong>
            </div>
            <div>
              <span>Errors</span>
              <strong>{selectedJob.consecutiveErrors}</strong>
            </div>
          </div>
        ) : null}

        <div className="button-row">
          <button
            className="primary-button"
            type="button"
            disabled={props.savePending}
            onClick={props.onSave}
          >
            {props.savePending ? 'Saving...' : 'Save job'}
          </button>
          <button
            className="ghost-button"
            type="button"
            disabled={props.savePending}
            onClick={props.onCancel}
          >
            Cancel
          </button>
          {selectedJob ? (
            <button
              className="ghost-button"
              type="button"
              disabled={props.pausePending}
              onClick={props.onPauseToggle}
            >
              {props.pausePending
                ? 'Updating...'
                : selectedJob.disabled
                  ? 'Resume job'
                  : 'Pause job'}
            </button>
          ) : null}
          {selectedJob ? (
            <button
              className="danger-button"
              type="button"
              disabled={props.deletePending}
              onClick={props.onDelete}
            >
              {props.deletePending ? 'Deleting...' : 'Delete job'}
            </button>
          ) : null}
        </div>
      </div>
    </Panel>
  );
}

export function SchedulerPage() {
  const auth = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    const requestedId =
      new URLSearchParams(window.location.search).get('jobId') || '';
    return requestedId.trim() || null;
  });
  const [draft, setDraft] = useState<SchedulerDraft>(createDraft());
  const [showEditor, setShowEditor] = useState<boolean>(() => {
    const requestedId =
      new URLSearchParams(window.location.search).get('jobId') || '';
    return Boolean(requestedId.trim());
  });

  const schedulerQuery = useQuery({
    queryKey: ['scheduler', auth.token],
    queryFn: () => fetchScheduler(auth.token),
  });
  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const channelsQuery = useQuery({
    queryKey: ['channels', auth.token],
    queryFn: () => fetchChannels(auth.token),
  });

  const selectedJob =
    schedulerQuery.data?.jobs.find((job) => job.id === selectedId) || null;
  const selectedConfigJob = isConfigJob(selectedJob) ? selectedJob : null;
  const channelOptions = buildSchedulerChannelOptions({
    config: configQuery.data?.config,
    status: auth.gatewayStatus,
    currentChannel: draft.deliveryChannel,
  });
  const targetControl = buildSchedulerTargetControl({
    channel: draft.deliveryChannel,
    currentValue: draft.deliveryTo,
    channels: channelsQuery.data,
  });

  const saveMutation = useMutation({
    mutationFn: (nextDraft: SchedulerDraft) =>
      saveSchedulerJob(auth.token, normalizeDraft(nextDraft)),
    onSuccess: (payload, nextDraft) => {
      replaceSchedulerJobs(payload, auth.token, queryClient);
      setSelectedId(nextDraft.id.trim());
      window.location.href = '/admin/jobs';
    },
    onError: (error) => {
      toast.error('Save failed', getErrorMessage(error));
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
      toast.success('Deleted.');
      setSelectedId(null);
      setDraft(createDraft());
    },
    onError: (error) => {
      toast.error('Delete failed', getErrorMessage(error));
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
    onSuccess: (payload, action) => {
      replaceSchedulerJobs(payload, auth.token, queryClient);
      toast.success(action === 'pause' ? 'Paused.' : 'Resumed.');
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
    onError: (error) => {
      toast.error('Pause/resume failed', getErrorMessage(error));
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

  useEffect(() => {
    const currentUrl = new URL(window.location.href);
    const currentJobId = currentUrl.searchParams.get('jobId')?.trim() || null;
    if (selectedId) {
      if (currentJobId === selectedId) return;
      currentUrl.searchParams.set('jobId', selectedId);
    } else if (!currentJobId) {
      return;
    } else {
      currentUrl.searchParams.delete('jobId');
    }
    window.history.replaceState({}, '', currentUrl.toString());
  }, [selectedId]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Scheduler"
        actions={
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDraft(createDraft());
              setShowEditor(true);
            }}
          >
            New job
          </button>
        }
      />

      <div className="two-column-grid">
        <Panel
          title="Jobs"
          subtitle={`${schedulerQuery.data?.jobs.length || 0} item${schedulerQuery.data?.jobs.length === 1 ? '' : 's'}`}
        >
          {schedulerQuery.isLoading ? (
            <div className="empty-state">Loading scheduler items...</div>
          ) : schedulerQuery.data?.jobs.length ? (
            <div className="list-stack selectable-list">
              {schedulerQuery.data.jobs.map((job) => (
                <button
                  key={job.id}
                  className={
                    job.id === selectedId
                      ? 'selectable-row active'
                      : 'selectable-row'
                  }
                  type="button"
                  onClick={() => {
                    setSelectedId(job.id);
                    setShowEditor(true);
                  }}
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
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state-cta">
              <p>
                Scheduled jobs let you run agent tasks automatically on a cron
                schedule.
              </p>
              <button
                className="primary-button"
                type="button"
                onClick={() => {
                  setSelectedId(null);
                  setDraft(createDraft());
                  setShowEditor(true);
                }}
              >
                New job
              </button>
            </div>
          )}
        </Panel>

        {showEditor ? (
          isTaskJob(selectedJob) ? (
            <SchedulerTaskDetail
              job={selectedJob}
              pausePending={pauseMutation.isPending}
              deletePending={deleteMutation.isPending}
              onPauseToggle={() =>
                pauseMutation.mutate(selectedJob.disabled ? 'resume' : 'pause')
              }
              onDelete={() => deleteMutation.mutate()}
            />
          ) : (
            <SchedulerJobEditor
              draft={draft}
              selectedJob={selectedConfigJob}
              channelOptions={channelOptions}
              targetControl={targetControl}
              savePending={saveMutation.isPending}
              pausePending={pauseMutation.isPending}
              deletePending={deleteMutation.isPending}
              onDraftChange={(update) => setDraft((current) => update(current))}
              onSave={() => {
                const nextDraft = prepareDraftForSave(
                  applyResolvedTarget(draft, targetControl),
                );
                setDraft(nextDraft);
                saveMutation.mutate(nextDraft);
              }}
              onCancel={() => {
                if (selectedConfigJob) {
                  setDraft(createDraft(selectedConfigJob));
                  return;
                }
                setSelectedId(null);
                setDraft(createDraft());
                setShowEditor(false);
                window.location.href = '/admin/jobs';
              }}
              onPauseToggle={() =>
                pauseMutation.mutate(
                  selectedConfigJob?.disabled ? 'resume' : 'pause',
                )
              }
              onDelete={() => deleteMutation.mutate()}
            />
          )
        ) : null}
      </div>
    </div>
  );
}
