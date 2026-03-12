import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { deleteChannel, fetchChannels, saveChannel } from '../api/client';
import type { AdminChannelConfig, AdminChannelsResponse } from '../api/types';
import { useAuth } from '../auth';
import { BooleanField, PageHeader, Panel } from '../components/ui';
import { joinStringList, parseStringList } from '../lib/format';

interface ChannelDraft {
  originalId: string | null;
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
}

function createDraft(
  source?: AdminChannelsResponse['channels'][number],
): ChannelDraft {
  return {
    originalId: source?.id || null,
    guildId: source?.guildId || '',
    channelId: source?.channelId || '',
    mode: source?.config.mode || source?.defaultMode || 'mention',
    typingMode: source?.config.typingMode || 'thinking',
    debounceMs:
      source?.config.debounceMs == null ? '' : String(source.config.debounceMs),
    ackReaction: source?.config.ackReaction || '',
    rateLimitPerUser:
      source?.config.rateLimitPerUser == null
        ? ''
        : String(source.config.rateLimitPerUser),
    maxConcurrentPerChannel:
      source?.config.maxConcurrentPerChannel == null
        ? ''
        : String(source.config.maxConcurrentPerChannel),
    allowSend: source?.config.allowSend === true,
    suppressPatterns: joinStringList(source?.config.suppressPatterns),
    sendAllowedUserIds: joinStringList(source?.config.sendAllowedUserIds),
    sendAllowedRoleIds: joinStringList(source?.config.sendAllowedRoleIds),
  };
}

function normalizeConfig(draft: ChannelDraft): AdminChannelConfig {
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
        guildId: draft.guildId,
        channelId: draft.channelId,
        config: normalizeConfig(draft),
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(['channels', auth.token], payload);
      const nextSelected =
        payload.channels.find(
          (entry) =>
            entry.guildId === draft.guildId &&
            entry.channelId === draft.channelId,
        ) || null;
      setSelectedId(nextSelected?.id || null);
      setDraft(createDraft(nextSelected || undefined));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteChannel(auth.token, draft.guildId, draft.channelId),
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
          subtitle={`Policy: ${channelsQuery.data?.groupPolicy || 'open'}`}
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
                  <span>{entry.config.mode}</span>
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
              <input value="discord" disabled readOnly />
            </label>
            <label className="field">
              <span>Guild ID</span>
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
                  placeholder={channelsQuery.data?.defaultAckReaction || 'none'}
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
