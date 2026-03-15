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
import { BooleanField, PageHeader, Panel } from '../components/ui';
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
      groupPolicy: source.config.groupPolicy || 'open',
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
    groupPolicy: 'open',
    allowFrom: '',
    tools: '',
  };
}

function normalizeConfig(
  draft: ChannelDraft,
): AdminDiscordChannelConfig | AdminMSTeamsChannelConfig {
  if (draft.transport === 'msteams') {
    return {
      requireMention: draft.requireMention,
      replyStyle: draft.replyStyle,
      groupPolicy: draft.groupPolicy,
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
          <button
            className="ghost-button"
            type="button"
            onClick={() => {
              setSelectedId(null);
              setDraft(createDraft());
            }}
          >
            New binding
          </button>
        }
      />

      <div className="two-column-grid channels-layout">
        <Panel
          title="Configured bindings"
          subtitle={`Discord policy: ${channelsQuery.data?.groupPolicy || 'open'} · Teams policy: ${channelsQuery.data?.msteams.groupPolicy || 'open'}`}
        >
          {channelsQuery.isLoading ? (
            <div className="empty-state">Loading bindings...</div>
          ) : channelsQuery.data?.channels.length ? (
            <div className="list-stack selectable-list">
              {channelsQuery.data.channels.map((entry) => (
                <button
                  key={entry.id}
                  className={
                    entry.id === selectedId
                      ? 'selectable-row active'
                      : 'selectable-row'
                  }
                  type="button"
                  onClick={() => setSelectedId(entry.id)}
                >
                  <div>
                    <strong>{entry.channelId}</strong>
                    <small>
                      {entry.transport} · {entry.guildId}
                    </small>
                  </div>
                  <span>{summarizeEntry(entry)}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty-state">No explicit bindings exist yet.</div>
          )}
        </Panel>

        <Panel title="Binding editor" accent="warm">
          <div className="stack-form">
            <label className="field">
              <span>Transport</span>
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
            </label>
            <label className="field">
              <span>
                {draft.transport === 'msteams' ? 'Team ID' : 'Guild ID'}
              </span>
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
            </label>
            <label className="field">
              <span>Channel ID</span>
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
            </label>

            {draft.transport === 'discord' ? (
              <>
                <div className="field-grid">
                  <label className="field">
                    <span>Mode</span>
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
                  </label>
                  <label className="field">
                    <span>Typing mode</span>
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
                  </label>
                </div>
                <div className="field-grid">
                  <label className="field">
                    <span>Debounce ms</span>
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
                  </label>
                  <label className="field">
                    <span>Ack reaction</span>
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
                  </label>
                </div>
                <div className="field-grid">
                  <label className="field">
                    <span>Rate limit per user</span>
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
                  </label>
                  <label className="field">
                    <span>Max concurrent</span>
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
                  </label>
                </div>
                <label className="field textarea-field">
                  <span>Suppress patterns</span>
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
                </label>
                <div className="field-grid">
                  <label className="field textarea-field">
                    <span>Allowed user IDs</span>
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
                  </label>
                  <label className="field textarea-field">
                    <span>Allowed role IDs</span>
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
                  </label>
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
                  <label className="field">
                    <span>Reply style</span>
                    <select
                      value={draft.replyStyle}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          replyStyle: event.target
                            .value as ChannelDraft['replyStyle'],
                        }))
                      }
                    >
                      <option value="thread">thread</option>
                      <option value="top-level">top-level</option>
                    </select>
                  </label>
                  <label className="field">
                    <span>Group policy</span>
                    <select
                      value={draft.groupPolicy}
                      onChange={(event) =>
                        setDraft((current) => ({
                          ...current,
                          groupPolicy: event.target
                            .value as ChannelDraft['groupPolicy'],
                        }))
                      }
                    >
                      <option value="open">open</option>
                      <option value="allowlist">allowlist</option>
                      <option value="disabled">disabled</option>
                    </select>
                  </label>
                </div>
                <label className="field textarea-field">
                  <span>Allowed AAD object IDs</span>
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
                </label>
                <label className="field textarea-field">
                  <span>Allowed tools</span>
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
                </label>
                <BooleanField
                  label="Require mention"
                  value={draft.requireMention}
                  trueLabel="on"
                  falseLabel="off"
                  onChange={(requireMention) =>
                    setDraft((current) => ({
                      ...current,
                      requireMention,
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
              <button
                className="primary-button"
                type="button"
                disabled={saveMutation.isPending}
                onClick={() => saveMutation.mutate()}
              >
                {saveMutation.isPending ? 'Saving...' : 'Save binding'}
              </button>
              <button
                className="ghost-button"
                type="button"
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
              </button>
            </div>
            {saveMutation.isSuccess ? (
              <p className="success-banner">Binding saved.</p>
            ) : null}
            {saveMutation.isError ? (
              <p className="error-banner">
                {(saveMutation.error as Error).message}
              </p>
            ) : null}
            {deleteMutation.isError ? (
              <p className="error-banner">
                {(deleteMutation.error as Error).message}
              </p>
            ) : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}
