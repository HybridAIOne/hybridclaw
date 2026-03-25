import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { deleteChannel, fetchChannels, saveChannel } from '../api/client';
import type {
  AdminChannelEntry,
  AdminChannelTransport,
  AdminDiscordChannelConfig,
  AdminMSTeamsChannelConfig,
} from '../api/types';
import { useAuth } from '../auth';
import {
  Banner,
  BooleanField,
  Button,
  EmptyState,
  FormField,
  PageHeader,
  Panel,
  SelectableRow,
} from '../components/ui';
import { joinStringList, parseStringList } from '../lib/format';

interface ChannelDraft {
  originalId: string | null;
  transport: AdminChannelTransport;
  guildId: string;
  channelId: string;
  mode: 'off' | 'mention' | 'free';
  typingMode: 'instant' | 'thinking' | 'streaming' | 'never';
  debounceMs: string;
  ackReaction: string;
  rateLimitPerUser: string;
  maxConcurrentPerChannel: string;
  allowSend: boolean;
  suppressPatterns: string;
  sendAllowedUserIds: string;
  sendAllowedRoleIds: string;
  requireMention: boolean;
  replyStyle: 'thread' | 'top-level';
  groupPolicy: 'open' | 'allowlist' | 'disabled';
  requireMentionExplicit: boolean;
  replyStyleExplicit: boolean;
  groupPolicyExplicit: boolean;
  allowFrom: string;
  tools: string;
}

function isDiscordEntry(
  entry?: AdminChannelEntry,
): entry is Extract<AdminChannelEntry, { transport: 'discord' }> {
  return entry?.transport === 'discord';
}

function isMSTeamsEntry(
  entry?: AdminChannelEntry,
): entry is Extract<AdminChannelEntry, { transport: 'msteams' }> {
  return entry?.transport === 'msteams';
}

function createDraft(source?: AdminChannelEntry): ChannelDraft {
  if (isMSTeamsEntry(source)) {
    return {
      originalId: source.id,
      transport: 'msteams',
      guildId: source.guildId,
      channelId: source.channelId,
      mode: 'mention',
      typingMode: 'thinking',
      debounceMs: '',
      ackReaction: '',
      rateLimitPerUser: '',
      maxConcurrentPerChannel: '',
      allowSend: false,
      suppressPatterns: '',
      sendAllowedUserIds: '',
      sendAllowedRoleIds: '',
      requireMention:
        source.config.requireMention ?? source.defaultRequireMention,
      replyStyle: source.config.replyStyle || source.defaultReplyStyle,
      groupPolicy: source.config.groupPolicy ?? source.defaultGroupPolicy,
      requireMentionExplicit: source.config.requireMention !== undefined,
      replyStyleExplicit: source.config.replyStyle !== undefined,
      groupPolicyExplicit: source.config.groupPolicy !== undefined,
      allowFrom: joinStringList(source.config.allowFrom),
      tools: joinStringList(source.config.tools),
    };
  }

  return {
    originalId: source?.id || null,
    transport: 'discord',
    guildId: source?.guildId || '',
    channelId: source?.channelId || '',
    mode: isDiscordEntry(source)
      ? source.config.mode || source.defaultMode
      : 'mention',
    typingMode: isDiscordEntry(source)
      ? source.config.typingMode || 'thinking'
      : 'thinking',
    debounceMs:
      isDiscordEntry(source) && source.config.debounceMs != null
        ? String(source.config.debounceMs)
        : '',
    ackReaction: isDiscordEntry(source) ? source.config.ackReaction || '' : '',
    rateLimitPerUser:
      isDiscordEntry(source) && source.config.rateLimitPerUser != null
        ? String(source.config.rateLimitPerUser)
        : '',
    maxConcurrentPerChannel:
      isDiscordEntry(source) && source.config.maxConcurrentPerChannel != null
        ? String(source.config.maxConcurrentPerChannel)
        : '',
    allowSend: isDiscordEntry(source)
      ? source.config.allowSend === true
      : false,
    suppressPatterns: isDiscordEntry(source)
      ? joinStringList(source.config.suppressPatterns)
      : '',
    sendAllowedUserIds: isDiscordEntry(source)
      ? joinStringList(source.config.sendAllowedUserIds)
      : '',
    sendAllowedRoleIds: isDiscordEntry(source)
      ? joinStringList(source.config.sendAllowedRoleIds)
      : '',
    requireMention: true,
    replyStyle: 'thread',
    groupPolicy: 'allowlist',
    requireMentionExplicit: false,
    replyStyleExplicit: false,
    groupPolicyExplicit: false,
    allowFrom: '',
    tools: '',
  };
}

function normalizeConfig(
  draft: ChannelDraft,
): AdminDiscordChannelConfig | AdminMSTeamsChannelConfig {
  if (draft.transport === 'msteams') {
    return {
      ...(draft.requireMentionExplicit
        ? { requireMention: draft.requireMention }
        : {}),
      ...(draft.replyStyleExplicit ? { replyStyle: draft.replyStyle } : {}),
      ...(draft.groupPolicyExplicit ? { groupPolicy: draft.groupPolicy } : {}),
      ...(parseStringList(draft.allowFrom).length > 0
        ? { allowFrom: parseStringList(draft.allowFrom) }
        : {}),
      ...(parseStringList(draft.tools).length > 0
        ? { tools: parseStringList(draft.tools) }
        : {}),
    };
  }

  return {
    mode: draft.mode,
    typingMode: draft.typingMode,
    ...(draft.debounceMs.trim()
      ? { debounceMs: Number.parseInt(draft.debounceMs, 10) || 0 }
      : {}),
    ...(draft.ackReaction.trim()
      ? { ackReaction: draft.ackReaction.trim() }
      : {}),
    ...(draft.rateLimitPerUser.trim()
      ? { rateLimitPerUser: Number.parseInt(draft.rateLimitPerUser, 10) || 0 }
      : {}),
    ...(draft.maxConcurrentPerChannel.trim()
      ? {
          maxConcurrentPerChannel:
            Number.parseInt(draft.maxConcurrentPerChannel, 10) || 0,
        }
      : {}),
    ...(draft.allowSend ? { allowSend: true } : {}),
    ...(parseStringList(draft.suppressPatterns).length > 0
      ? { suppressPatterns: parseStringList(draft.suppressPatterns) }
      : {}),
    ...(parseStringList(draft.sendAllowedUserIds).length > 0
      ? { sendAllowedUserIds: parseStringList(draft.sendAllowedUserIds) }
      : {}),
    ...(parseStringList(draft.sendAllowedRoleIds).length > 0
      ? { sendAllowedRoleIds: parseStringList(draft.sendAllowedRoleIds) }
      : {}),
  };
}

function summarizeEntry(entry: AdminChannelEntry): string {
  if (entry.transport === 'msteams') {
    return entry.config.replyStyle || entry.defaultReplyStyle;
  }
  return entry.config.mode;
}

export function ChannelsPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ChannelDraft>(createDraft());

  const channelsQuery = useQuery({
    queryKey: ['channels', auth.token],
    queryFn: () => fetchChannels(auth.token),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      saveChannel(auth.token, {
        transport: draft.transport,
        guildId: draft.guildId,
        channelId: draft.channelId,
        config: normalizeConfig(draft),
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(['channels', auth.token], payload);
      const nextSelected =
        payload.channels.find(
          (entry) =>
            entry.transport === draft.transport &&
            entry.guildId === draft.guildId &&
            entry.channelId === draft.channelId,
        ) || null;
      setSelectedId(nextSelected?.id || null);
      setDraft(createDraft(nextSelected || undefined));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      deleteChannel(
        auth.token,
        draft.transport,
        draft.guildId,
        draft.channelId,
      ),
    onSuccess: (payload) => {
      queryClient.setQueryData(['channels', auth.token], payload);
      setSelectedId(null);
      setDraft(createDraft());
    },
  });

  const selectedChannel =
    channelsQuery.data?.channels.find((entry) => entry.id === selectedId) ||
    null;

  useEffect(() => {
    if (selectedChannel) {
      setDraft(createDraft(selectedChannel));
      return;
    }
    if (!selectedId) {
      setDraft(createDraft());
    }
  }, [selectedChannel, selectedId]);

  return (
    <div className="page-stack">
      <PageHeader
        title="Bindings"
        actions={
          <Button
            variant="ghost"
            onClick={() => {
              setSelectedId(null);
              setDraft(createDraft());
            }}
          >
            New binding
          </Button>
        }
      />

      <div className="two-column-grid channels-layout">
        <Panel
          title="Configured bindings"
          subtitle={`Discord policy: ${channelsQuery.data?.groupPolicy || 'open'} · Teams policy: ${channelsQuery.data?.msteams.groupPolicy || 'open'}`}
        >
          {channelsQuery.isLoading ? (
            <EmptyState>Loading bindings...</EmptyState>
          ) : channelsQuery.data?.channels.length ? (
            <div className="list-stack selectable-list">
              {channelsQuery.data.channels.map((entry) => (
                <SelectableRow
                  key={entry.id}
                  active={entry.id === selectedId}
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div>
                    <strong>{entry.channelId}</strong>
                    <small>
                      {entry.transport} · {entry.guildId}
                    </small>
                  </div>
                  <span>{summarizeEntry(entry)}</span>
                </SelectableRow>
              ))}
            </div>
          ) : (
            <EmptyState>No explicit bindings exist yet.</EmptyState>
          )}
        </Panel>

        <Panel title="Binding editor" accent="warm">
          <div className="stack-form">
            <FormField label="Transport">
              <select
                value={draft.transport}
                onChange={(event) =>
                  setDraft(() => ({
                    ...createDraft(),
                    transport: event.target.value as AdminChannelTransport,
                  }))
                }
              >
                <option value="discord">discord</option>
                <option value="msteams">msteams</option>
              </select>
            </FormField>
            <FormField
              label={
                draft.transport === 'msteams' ? 'Team ID' : 'Guild ID'
              }
            >
              <input
                value={draft.guildId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    guildId: event.target.value,
                  }))
                }
                placeholder="1234567890"
              />
            </FormField>
            <FormField label="Channel ID">
              <input
                value={draft.channelId}
                onChange={(event) =>
                  setDraft((current) => ({
                    ...current,
                    channelId: event.target.value,
                  }))
                }
                placeholder="0987654321"
              />
            </FormField>

            {draft.transport === 'discord' ? (
              <>
                <div className="field-grid">
                  <FormField label="Mode">
                    <select
                      value={draft.mode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          mode: event.target.value as ChannelDraft['mode'],
                        }))
                      }
                    >
                      <option value="off">off</option>
                      <option value="mention">mention</option>
                      <option value="free">free</option>
                    </select>
                  </FormField>
                  <FormField label="Typing mode">
                    <select
                      value={draft.typingMode}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          typingMode: event.target
                            .value as ChannelDraft['typingMode'],
                        }))
                      }
                    >
                      <option value="instant">instant</option>
                      <option value="thinking">thinking</option>
                      <option value="streaming">streaming</option>
                      <option value="never">never</option>
                    </select>
                  </FormField>
                </div>
                <div className="field-grid">
                  <FormField label="Debounce ms">
                    <input
                      value={draft.debounceMs}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          debounceMs: event.target.value,
                        }))
                      }
                      placeholder={String(
                        channelsQuery.data?.defaultDebounceMs || 2500,
                      )}
                    />
                  </FormField>
                  <FormField label="Ack reaction">
                    <input
                      value={draft.ackReaction}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          ackReaction: event.target.value,
                        }))
                      }
                      placeholder={
                        channelsQuery.data?.defaultAckReaction || 'none'
                      }
                    />
                  </FormField>
                </div>
                <div className="field-grid">
                  <FormField label="Rate limit per user">
                    <input
                      value={draft.rateLimitPerUser}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          rateLimitPerUser: event.target.value,
                        }))
                      }
                      placeholder={String(
                        channelsQuery.data?.defaultRateLimitPerUser || 0,
                      )}
                    />
                  </FormField>
                  <FormField label="Max concurrent">
                    <input
                      value={draft.maxConcurrentPerChannel}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          maxConcurrentPerChannel: event.target.value,
                        }))
                      }
                      placeholder={String(
                        channelsQuery.data?.defaultMaxConcurrentPerChannel || 2,
                      )}
                    />
                  </FormField>
                </div>
                <FormField label="Suppress patterns">
                  <textarea
                    rows={3}
                    value={draft.suppressPatterns}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        suppressPatterns: event.target.value,
                      }))
                    }
                    placeholder="comma or newline separated"
                  />
                </FormField>
                <div className="field-grid">
                  <FormField label="Allowed user IDs">
                    <textarea
                      rows={3}
                      value={draft.sendAllowedUserIds}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          sendAllowedUserIds: event.target.value,
                        }))
                      }
                    />
                  </FormField>
                  <FormField label="Allowed role IDs">
                    <textarea
                      rows={3}
                      value={draft.sendAllowedRoleIds}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          sendAllowedRoleIds: event.target.value,
                        }))
                      }
                    />
                  </FormField>
                </div>
                <BooleanField
                  label="Send actions"
                  value={draft.allowSend}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(allowSend) =>
                    setDraft((current) => ({
                      ...current,
                      allowSend,
                    }))
                  }
                />
              </>
            ) : (
              <>
                <div className="field-grid">
                  <FormField label="Reply style">
                    <select
                      value={draft.replyStyle}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          replyStyle: event.target
                            .value as ChannelDraft['replyStyle'],
                          replyStyleExplicit: true,
                        }))
                      }
                    >
                      <option value="thread">thread</option>
                      <option value="top-level">top-level</option>
                    </select>
                  </FormField>
                  <FormField label="Group policy">
                    <select
                      value={draft.groupPolicy}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          groupPolicy: event.target
                            .value as ChannelDraft['groupPolicy'],
                          groupPolicyExplicit: true,
                        }))
                      }
                    >
                      <option value="open">open</option>
                      <option value="allowlist">allowlist</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </FormField>
                </div>
                <FormField label="Allowed AAD object IDs">
                  <textarea
                    rows={4}
                    value={draft.allowFrom}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        allowFrom: event.target.value,
                      }))
                    }
                    placeholder="comma or newline separated"
                  />
                </FormField>
                <FormField label="Allowed tools">
                  <textarea
                    rows={3}
                    value={draft.tools}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        tools: event.target.value,
                      }))
                    }
                    placeholder="comma or newline separated"
                  />
                </FormField>
                <BooleanField
                  label="Require mention"
                  value={draft.requireMention}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(requireMention) =>
                    setDraft((current) => ({
                      ...current,
                      requireMention,
                      requireMentionExplicit: true,
                    }))
                  }
                />
                <p className="muted-copy">
                  Teams defaults:{' '}
                  {channelsQuery.data?.msteams.defaultReplyStyle || 'thread'}{' '}
                  replies, mention requirement{' '}
                  {channelsQuery.data?.msteams.defaultRequireMention
                    ? 'on'
                    : 'off'}
                  .
                </p>
              </>
            )}

            <div className="button-row">
              <Button
                variant="primary"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? 'Saving...' : 'Save binding'}
              </Button>
              <Button
                variant="ghost"
                disabled={!draft.originalId || deleteMutation.isPending}
                onClick={() => {
                  const confirmed = window.confirm(
                    `Remove explicit binding for ${draft.channelId}?`,
                  );
                  if (!confirmed) return;
                  deleteMutation.mutate();
                }}
              >
                {deleteMutation.isPending ? 'Removing...' : 'Remove binding'}
              </Button>
            </div>
            {saveMutation.isSuccess ? (
              <Banner variant="success">Binding saved.</Banner>
            ) : null}
            {saveMutation.isError ? (
              <Banner variant="error">
                {(saveMutation.error as Error).message}
              </Banner>
            ) : null}
            {deleteMutation.isError ? (
              <Banner variant="error">
                {(deleteMutation.error as Error).message}
              </Banner>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
