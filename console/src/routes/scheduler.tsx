import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
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
import { Button } from '../components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../components/card';
import {
  Field,
  FieldContent,
  FieldError,
  FieldLabel,
} from '../components/field';
import { Input } from '../components/input';
import { NativeSelect, NativeSelectOption } from '../components/native-select';
import { NumberField } from '../components/number-field';
import { Switch } from '../components/switch';
import { Textarea } from '../components/textarea';
import { useToast } from '../components/toast';
import { BooleanPill, PageHeader } from '../components/ui';
import { useFormMutation } from '../hooks/use-form-mutation';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime } from '../lib/format';
import { logNavigationError } from '../lib/navigation';
import { buildChannelCatalog } from './channels-catalog';

const BOARD_STATUSES = [
  'backlog',
  'in_progress',
  'review',
  'done',
  'cancelled',
] as const;
type BoardStatus = (typeof BOARD_STATUSES)[number];

const SCHEDULE_KINDS = ['cron', 'every', 'at', 'one_shot'] as const;
type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

const ACTION_KINDS = ['agent_turn', 'system_event'] as const;
type ActionKind = (typeof ACTION_KINDS)[number];

const DELIVERY_KINDS = ['channel', 'last-channel', 'webhook'] as const;
type DeliveryKind = (typeof DELIVERY_KINDS)[number];

function asBoardStatus(value: string, fallback: BoardStatus): BoardStatus {
  return (BOARD_STATUSES as readonly string[]).includes(value)
    ? (value as BoardStatus)
    : fallback;
}

function asScheduleKind(value: string, fallback: ScheduleKind): ScheduleKind {
  return (SCHEDULE_KINDS as readonly string[]).includes(value)
    ? (value as ScheduleKind)
    : fallback;
}

function asActionKind(value: string, fallback: ActionKind): ActionKind {
  return (ACTION_KINDS as readonly string[]).includes(value)
    ? (value as ActionKind)
    : fallback;
}

function asDeliveryKind(value: string, fallback: DeliveryKind): DeliveryKind {
  return (DELIVERY_KINDS as readonly string[]).includes(value)
    ? (value as DeliveryKind)
    : fallback;
}

interface SchedulerDraft {
  originalId: string | null;
  id: string;
  name: string;
  description: string;
  agentId: string;
  boardStatus: BoardStatus;
  enabled: boolean;
  scheduleKind: ScheduleKind;
  scheduleExpr: string;
  scheduleEveryMs: number;
  scheduleAt: string;
  scheduleTz: string;
  maxRetries: number;
  actionKind: ActionKind;
  actionMessage: string;
  deliveryKind: DeliveryKind;
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

function isSchedulerJob(
  job: AdminSchedulerJob | null | undefined,
): job is AdminSchedulerJob & { source: 'job' } {
  return job?.source === 'job';
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
    scheduleEveryMs: source?.schedule.everyMs ?? 60_000,
    scheduleAt: toDateTimeLocal(source?.schedule.at || null),
    scheduleTz: source?.schedule.tz || '',
    maxRetries: typeof source?.maxRetries === 'number' ? source.maxRetries : 3,
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

  return {
    id: draft.id.trim(),
    source: 'job',
    name: draft.name.trim() || draft.id.trim(),
    description: draft.description.trim() || null,
    agentId: draft.agentId.trim() || null,
    boardStatus: draft.boardStatus,
    maxRetries: draft.scheduleKind === 'one_shot' ? draft.maxRetries : null,
    enabled: draft.enabled,
    schedule: {
      kind: draft.scheduleKind,
      at,
      everyMs: draft.scheduleKind === 'every' ? draft.scheduleEveryMs : null,
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

function replaceJobs(
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
    <Card variant="muted">
      <CardHeader>
        <CardTitle>Task</CardTitle>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

function SchedulerJobEditor(props: {
  draft: SchedulerDraft;
  selectedJob: (AdminSchedulerJob & { source: 'job' }) | null;
  channelOptions: SchedulerChannelOption[];
  targetControl: SchedulerTargetControl;
  savePending: boolean;
  pausePending: boolean;
  deletePending: boolean;
  everyMsError: string | null;
  maxRetriesError: string | null;
  saveDisabled: boolean;
  onDraftChange: (update: (current: SchedulerDraft) => SchedulerDraft) => void;
  onEveryMsErrorChange: (error: string | null) => void;
  onMaxRetriesErrorChange: (error: string | null) => void;
  onSave: () => void;
  onCancel: () => void;
  onPauseToggle: () => void;
  onDelete: () => void;
}) {
  const { draft, selectedJob } = props;

  return (
    <Card variant="muted">
      <CardHeader>
        <CardTitle>Job</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="stack-form">
          <div className="field-grid">
            <Field>
              <FieldLabel>ID</FieldLabel>
              <Input
                value={draft.id}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    id: event.target.value,
                  }))
                }
                placeholder="Auto-generated from name if blank"
              />
            </Field>
            <Field>
              <FieldLabel>Name</FieldLabel>
              <Input
                value={draft.name}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder="Nightly research"
              />
            </Field>
          </div>

          <Field>
            <FieldLabel>Description</FieldLabel>
            <Input
              value={draft.description}
              onChange={(event) =>
                props.onDraftChange((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
              placeholder="Optional"
            />
          </Field>

          <div className="field-grid">
            <Field>
              <FieldLabel>Status</FieldLabel>
              <NativeSelect
                value={draft.boardStatus}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    boardStatus: asBoardStatus(
                      event.target.value,
                      current.boardStatus,
                    ),
                  }))
                }
              >
                <NativeSelectOption value="backlog">backlog</NativeSelectOption>
                <NativeSelectOption value="in_progress">
                  in progress
                </NativeSelectOption>
                <NativeSelectOption value="review">review</NativeSelectOption>
                <NativeSelectOption value="done">done</NativeSelectOption>
                <NativeSelectOption value="cancelled">
                  cancelled
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field orientation="horizontal">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(enabled) =>
                  props.onDraftChange((current) => ({ ...current, enabled }))
                }
              />
              <FieldContent>
                <FieldLabel>State</FieldLabel>
              </FieldContent>
            </Field>
          </div>

          <div className="field-grid">
            <Field>
              <FieldLabel>Schedule</FieldLabel>
              <NativeSelect
                value={draft.scheduleKind}
                onChange={(event) =>
                  props.onDraftChange((current) => {
                    const nextKind = asScheduleKind(
                      event.target.value,
                      current.scheduleKind,
                    );
                    return {
                      ...current,
                      scheduleKind: nextKind,
                      boardStatus:
                        nextKind === 'one_shot'
                          ? 'backlog'
                          : current.boardStatus,
                    };
                  })
                }
              >
                <NativeSelectOption value="cron">cron</NativeSelectOption>
                <NativeSelectOption value="every">every</NativeSelectOption>
                <NativeSelectOption value="at">at</NativeSelectOption>
                <NativeSelectOption value="one_shot">
                  one shot
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            {draft.scheduleKind !== 'one_shot' ? (
              <Field>
                <FieldLabel>Timezone</FieldLabel>
                <Input
                  value={draft.scheduleTz}
                  onChange={(event) =>
                    props.onDraftChange((current) => ({
                      ...current,
                      scheduleTz: event.target.value,
                    }))
                  }
                  placeholder="Europe/Berlin"
                />
              </Field>
            ) : null}
          </div>

          {draft.scheduleKind === 'cron' ? (
            <Field>
              <FieldLabel>Cron</FieldLabel>
              <Input
                value={draft.scheduleExpr}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    scheduleExpr: event.target.value,
                  }))
                }
                placeholder="0 * * * *"
              />
            </Field>
          ) : null}

          {draft.scheduleKind === 'every' ? (
            <Field invalid={Boolean(props.everyMsError)}>
              <FieldLabel>Every ms</FieldLabel>
              <NumberField
                integer
                min={1}
                value={draft.scheduleEveryMs}
                onValueChange={(scheduleEveryMs) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    scheduleEveryMs,
                  }))
                }
                onErrorChange={props.onEveryMsErrorChange}
                placeholder="60000"
              />
              <FieldError>{props.everyMsError}</FieldError>
            </Field>
          ) : null}

          {draft.scheduleKind === 'at' ? (
            <Field>
              <FieldLabel>Run at</FieldLabel>
              <Input
                type="datetime-local"
                value={draft.scheduleAt}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    scheduleAt: event.target.value,
                  }))
                }
              />
            </Field>
          ) : null}

          {draft.scheduleKind === 'one_shot' ? (
            <Field invalid={Boolean(props.maxRetriesError)}>
              <FieldLabel>Retries after failure</FieldLabel>
              <NumberField
                integer
                min={0}
                max={100}
                value={draft.maxRetries}
                onValueChange={(maxRetries) =>
                  props.onDraftChange((current) => ({ ...current, maxRetries }))
                }
                onErrorChange={props.onMaxRetriesErrorChange}
                placeholder="3"
              />
              <FieldError>{props.maxRetriesError}</FieldError>
            </Field>
          ) : null}

          <div className="field-grid">
            <Field>
              <FieldLabel>Action</FieldLabel>
              <NativeSelect
                value={draft.actionKind}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    actionKind: asActionKind(
                      event.target.value,
                      current.actionKind,
                    ),
                  }))
                }
              >
                <NativeSelectOption value="agent_turn">
                  agent_turn
                </NativeSelectOption>
                <NativeSelectOption value="system_event">
                  system_event
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel>Delivery</FieldLabel>
              <NativeSelect
                value={draft.deliveryKind}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    deliveryKind: asDeliveryKind(
                      event.target.value,
                      current.deliveryKind,
                    ),
                  }))
                }
              >
                <NativeSelectOption value="channel">channel</NativeSelectOption>
                <NativeSelectOption value="last-channel">
                  last-channel
                </NativeSelectOption>
                <NativeSelectOption value="webhook">webhook</NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>

          <Field>
            <FieldLabel>Message</FieldLabel>
            <Textarea
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
          </Field>

          {draft.deliveryKind === 'channel' ? (
            <div className="field-grid">
              <Field>
                <FieldLabel>Channel type</FieldLabel>
                <NativeSelect
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
                    <NativeSelectOption key={option.value} value={option.value}>
                      {option.label}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              {props.targetControl.kind === 'select' ? (
                <Field>
                  <FieldLabel>{props.targetControl.label}</FieldLabel>
                  <NativeSelect
                    value={props.targetControl.value}
                    onChange={(event) =>
                      props.onDraftChange((current) => ({
                        ...current,
                        deliveryTo: event.target.value,
                      }))
                    }
                  >
                    {props.targetControl.options.map((option) => (
                      <NativeSelectOption
                        key={option.value}
                        value={option.value}
                      >
                        {option.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
              ) : null}
              {props.targetControl.kind === 'input' ? (
                <Field>
                  <FieldLabel>{props.targetControl.label}</FieldLabel>
                  <Input
                    value={props.targetControl.value}
                    onChange={(event) =>
                      props.onDraftChange((current) => ({
                        ...current,
                        deliveryTo: event.target.value,
                      }))
                    }
                    placeholder={props.targetControl.placeholder}
                  />
                </Field>
              ) : null}
            </div>
          ) : null}

          {draft.deliveryKind === 'webhook' ? (
            <Field>
              <FieldLabel>Webhook URL</FieldLabel>
              <Input
                type="url"
                value={draft.deliveryWebhookUrl}
                onChange={(event) =>
                  props.onDraftChange((current) => ({
                    ...current,
                    deliveryWebhookUrl: event.target.value,
                  }))
                }
                placeholder="https://example.test/hook"
              />
            </Field>
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
            <Button
              type="button"
              loading={props.savePending}
              disabled={props.saveDisabled}
              onClick={props.onSave}
            >
              {props.savePending ? 'Saving...' : 'Save job'}
            </Button>
            <Button
              variant="ghost"
              type="button"
              disabled={props.savePending}
              onClick={props.onCancel}
            >
              Cancel
            </Button>
            {selectedJob ? (
              <Button
                variant="ghost"
                type="button"
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
                type="button"
                loading={props.deletePending}
                disabled={props.deletePending}
                onClick={props.onDelete}
              >
                {props.deletePending ? 'Deleting...' : 'Delete job'}
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SchedulerPage() {
  const auth = useAuth();
  const navigate = useNavigate();
  const schedulerSearch = useSearch({ strict: false }) as { jobId?: string };
  const toast = useToast();
  const queryClient = useQueryClient();
  const selectedId = schedulerSearch.jobId?.trim() || null;
  const setSelectedId = useCallback(
    (jobId: string | null) => {
      void navigate({
        to: '/admin/scheduler',
        replace: true,
        search: { jobId: jobId || undefined },
      }).catch(logNavigationError);
    },
    [navigate],
  );
  const [draft, setDraft] = useState<SchedulerDraft>(createDraft());
  const [everyMsError, setEveryMsError] = useState<string | null>(null);
  const [maxRetriesError, setMaxRetriesError] = useState<string | null>(null);

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
  const selectedConfigJob = isSchedulerJob(selectedJob) ? selectedJob : null;
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

  const saveMutation = useFormMutation({
    mutationFn: (nextDraft: SchedulerDraft) =>
      saveSchedulerJob(auth.token, normalizeDraft(nextDraft)),
    onSuccess: (payload) => {
      replaceJobs(payload, auth.token, queryClient);
      void navigate({ to: '/admin/jobs' }).catch(logNavigationError);
    },
    onError: (error) => {
      toast.error('Save failed', error.message);
    },
    invalidates: [['overview']],
  });

  const formInvalid = Boolean(everyMsError) || Boolean(maxRetriesError);
  const saveDisabled = saveMutation.isPending || formInvalid;

  const deleteMutation = useMutation({
    mutationFn: () => {
      if (!selectedJob) {
        throw new Error('Select a scheduler item first.');
      }
      return deleteSchedulerJob(auth.token, selectedJob);
    },
    onSuccess: (payload) => {
      replaceJobs(payload, auth.token, queryClient);
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
            source: 'job',
            jobId: selectedJob.id,
            action,
          });
    },
    onSuccess: (payload, action) => {
      replaceJobs(payload, auth.token, queryClient);
      toast.success(action === 'pause' ? 'Paused.' : 'Resumed.');
      if (!selectedJob) return;
      const refreshed =
        payload.jobs.find((job) => job.id === selectedJob.id) || null;
      if (!refreshed) {
        setSelectedId(null);
        setDraft(createDraft());
        return;
      }
      if (isSchedulerJob(refreshed)) {
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
  }, [schedulerQuery.isLoading, selectedId, selectedJob, setSelectedId]);

  return (
    <div className="page-stack">
      <PageHeader
        actions={
          <Button
            variant="ghost"
            type="button"
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
        <Card>
          <CardHeader>
            <CardTitle>Jobs</CardTitle>
            <CardDescription>
              {`${schedulerQuery.data?.jobs.length || 0} item${schedulerQuery.data?.jobs.length === 1 ? '' : 's'}`}
            </CardDescription>
          </CardHeader>
          <CardContent>
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
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">No scheduled work yet.</div>
            )}
          </CardContent>
        </Card>

        {isTaskJob(selectedJob) ? (
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
            everyMsError={everyMsError}
            maxRetriesError={maxRetriesError}
            saveDisabled={saveDisabled}
            onDraftChange={(update) => setDraft((current) => update(current))}
            onEveryMsErrorChange={setEveryMsError}
            onMaxRetriesErrorChange={setMaxRetriesError}
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
              void navigate({ to: '/admin/jobs' }).catch(logNavigationError);
            }}
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
