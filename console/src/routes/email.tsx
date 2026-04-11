import { useQuery } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import {
  fetchAdminEmailMailbox,
  fetchConfig,
  fetchHistory,
} from '../api/client';
import type { AdminEmailThread, GatewayHistoryMessage } from '../api/types';
import { useAuth } from '../auth';
import { PageHeader, Panel } from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

type MailboxFolder = 'inbox' | 'needs-reply' | 'replied' | 'all-mail';

const MAILBOX_FOLDERS: ReadonlyArray<{
  id: MailboxFolder;
  label: string;
  description: string;
}> = [
  {
    id: 'inbox',
    label: 'Inbox',
    description: 'All tracked email threads',
  },
  {
    id: 'needs-reply',
    label: 'Needs reply',
    description: 'Last message came from the sender',
  },
  {
    id: 'replied',
    label: 'Replied',
    description: 'HybridClaw answered last',
  },
  {
    id: 'all-mail',
    label: 'All mail',
    description: 'Unfiltered mailbox mirror',
  },
];

const HISTORY_LIMIT = 200;
const INLINE_SUBJECT_RE = /^\[subject:\s*([^\]\n]+)\]\s*(?:\n+)?/i;

function stripInlineSubject(raw: string): string {
  return raw.replace(INLINE_SUBJECT_RE, '').trim();
}

function matchesFolder(
  thread: AdminEmailThread,
  folder: MailboxFolder,
): boolean {
  if (folder === 'needs-reply') {
    return thread.lastMessageRole === 'user';
  }
  if (folder === 'replied') {
    return thread.lastMessageRole === 'assistant';
  }
  return true;
}

function matchesSearch(thread: AdminEmailThread, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    thread.senderName || '',
    thread.channelId,
    thread.subject,
    thread.preview || '',
    thread.summary || '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

function visibleMailboxMessages(
  messages: GatewayHistoryMessage[] | undefined,
): GatewayHistoryMessage[] {
  return (messages || []).filter((message) => {
    const role = String(message.role || '').toLowerCase();
    return role === 'user' || role === 'assistant';
  });
}

function threadSenderLabel(thread: AdminEmailThread): string {
  return thread.senderName?.trim() || thread.channelId;
}

function messageAuthorLabel(
  message: GatewayHistoryMessage,
  thread: AdminEmailThread,
): string {
  if (String(message.role || '').toLowerCase() === 'assistant') {
    return 'HybridClaw';
  }
  return String(message.username || '').trim() || threadSenderLabel(thread);
}

function messageMetaLabel(
  message: GatewayHistoryMessage,
  thread: AdminEmailThread,
): string {
  if (String(message.role || '').toLowerCase() === 'assistant') {
    return `reply to ${thread.channelId}`;
  }
  return thread.channelId;
}

export function EmailPage() {
  const auth = useAuth();
  const [folder, setFolder] = useState<MailboxFolder>('inbox');
  const [search, setSearch] = useState('');
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(
    null,
  );
  const deferredSearch = useDeferredValue(search);

  const configQuery = useQuery({
    queryKey: ['config', auth.token],
    queryFn: () => fetchConfig(auth.token),
  });
  const mailboxQuery = useQuery({
    queryKey: ['admin-email-mailbox', auth.token],
    queryFn: () => fetchAdminEmailMailbox(auth.token),
  });

  const emailEnabled = configQuery.data?.config.email.enabled === true;
  const mailbox = mailboxQuery.data;
  const filteredThreads = (mailbox?.threads || []).filter(
    (thread) =>
      matchesFolder(thread, folder) && matchesSearch(thread, deferredSearch),
  );
  const selectedThread =
    filteredThreads.find((thread) => thread.sessionId === selectedSessionId) ||
    filteredThreads[0] ||
    null;
  const historyQuery = useQuery({
    queryKey: ['history', auth.token, selectedThread?.sessionId, HISTORY_LIMIT],
    queryFn: () =>
      fetchHistory(auth.token, {
        sessionId: selectedThread?.sessionId || '',
        limit: HISTORY_LIMIT,
      }),
    enabled: emailEnabled && Boolean(selectedThread?.sessionId),
  });

  useEffect(() => {
    if (!filteredThreads.length) {
      if (selectedSessionId !== null) {
        setSelectedSessionId(null);
      }
      return;
    }
    if (
      !filteredThreads.some((thread) => thread.sessionId === selectedSessionId)
    ) {
      setSelectedSessionId(filteredThreads[0]?.sessionId || null);
    }
  }, [filteredThreads, selectedSessionId]);

  if (configQuery.isLoading && !configQuery.data) {
    return <div className="empty-state">Loading mailbox settings...</div>;
  }

  if (configQuery.isError && !configQuery.data) {
    return (
      <div className="empty-state error">
        {(configQuery.error as Error).message}
      </div>
    );
  }

  if (!emailEnabled) {
    return (
      <div className="page-stack">
        <PageHeader
          title="Email"
          description="Enable the email channel to surface a mailbox view here."
          actions={
            <a className="ghost-button" href="/admin/channels">
              Open channel settings
            </a>
          }
        />

        <Panel title="Email mailbox" accent="warm">
          <div className="empty-state">
            Email is currently disabled. Turn on the email channel first, then
            return to `/admin/email`.
          </div>
        </Panel>
      </div>
    );
  }

  if (mailboxQuery.isLoading && !mailbox) {
    return <div className="empty-state">Loading mailbox...</div>;
  }

  if (mailboxQuery.isError && !mailbox) {
    return (
      <div className="empty-state error">
        {(mailboxQuery.error as Error).message}
      </div>
    );
  }

  const messages = visibleMailboxMessages(historyQuery.data?.history);
  const mailboxAddress =
    mailbox?.address.trim() ||
    configQuery.data?.config.email.address.trim() ||
    'mailbox';

  return (
    <div className="page-stack">
      <PageHeader
        title="Email"
        description={`Simple mailbox view for ${mailboxAddress}. It uses stored email session history, so the first pass stays lightweight and admin-native.`}
        actions={
          <input
            className="compact-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sender, subject, preview"
          />
        }
      />

      <Panel title="Mailbox" subtitle={mailboxAddress} accent="warm">
        <div className="mailbox-shell">
          <aside className="mailbox-sidebar">
            <div className="mailbox-sidebar-section">
              <p className="eyebrow">Folders</p>
              <div className="mailbox-folder-list">
                {MAILBOX_FOLDERS.map((item) => {
                  const count = (mailbox?.threads || []).filter((thread) =>
                    matchesFolder(thread, item.id),
                  ).length;
                  return (
                    <button
                      key={item.id}
                      className={
                        folder === item.id
                          ? 'mailbox-folder-button active'
                          : 'mailbox-folder-button'
                      }
                      type="button"
                      onClick={() => setFolder(item.id)}
                    >
                      <span>{item.label}</span>
                      <strong>{count}</strong>
                      <small>{item.description}</small>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mailbox-sidebar-section">
              <p className="eyebrow">Watched IMAP folders</p>
              {mailbox?.folders.length ? (
                <div className="mailbox-tag-list">
                  {mailbox.folders.map((folderName) => (
                    <span key={folderName} className="meta-chip">
                      {folderName}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="supporting-text">
                  No extra IMAP folders configured. This view is mirroring the
                  default inbox only.
                </p>
              )}
            </div>
          </aside>

          <section className="mailbox-thread-column">
            <div className="mailbox-column-header">
              <div>
                <strong>
                  {MAILBOX_FOLDERS.find((item) => item.id === folder)?.label}
                </strong>
                <small>
                  {filteredThreads.length} thread
                  {filteredThreads.length === 1 ? '' : 's'}
                </small>
              </div>
              <span className="meta-chip">
                {mailbox?.threads.length || 0} total
              </span>
            </div>

            <div className="mailbox-thread-list">
              {filteredThreads.length === 0 ? (
                <div className="empty-state">
                  No email threads match this folder and search.
                </div>
              ) : (
                filteredThreads.map((thread) => (
                  <button
                    key={thread.sessionId}
                    className={
                      thread.sessionId === selectedThread?.sessionId
                        ? 'mailbox-thread-button active'
                        : 'mailbox-thread-button'
                    }
                    type="button"
                    onClick={() => setSelectedSessionId(thread.sessionId)}
                  >
                    <div className="mailbox-thread-top">
                      <strong>{threadSenderLabel(thread)}</strong>
                      <span>{formatRelativeTime(thread.lastActive)}</span>
                    </div>
                    <div className="mailbox-thread-copy">
                      <span>{thread.subject}</span>
                      <small>
                        {thread.preview || 'No preview available yet.'}
                      </small>
                    </div>
                    <div className="mailbox-thread-meta">
                      <span className="meta-chip">
                        {thread.messageCount} msgs
                      </span>
                      {thread.lastMessageRole === 'user' ? (
                        <span className="mailbox-role-pill needs-reply">
                          Needs reply
                        </span>
                      ) : thread.lastMessageRole === 'assistant' ? (
                        <span className="mailbox-role-pill replied">
                          Replied
                        </span>
                      ) : null}
                    </div>
                  </button>
                ))
              )}
            </div>
          </section>

          <section className="mailbox-detail">
            {!selectedThread ? (
              <div className="empty-state mailbox-detail-empty">
                Pick a thread to inspect its stored conversation.
              </div>
            ) : (
              <>
                <div className="mailbox-detail-header">
                  <div className="mailbox-detail-copy">
                    <div className="mailbox-detail-heading">
                      <h3>{selectedThread.subject}</h3>
                      {selectedThread.lastMessageRole === 'user' ? (
                        <span className="mailbox-role-pill needs-reply">
                          Waiting on HybridClaw
                        </span>
                      ) : selectedThread.lastMessageRole === 'assistant' ? (
                        <span className="mailbox-role-pill replied">
                          Last reply sent
                        </span>
                      ) : null}
                    </div>
                    <p className="supporting-text">
                      {threadSenderLabel(selectedThread)} ·{' '}
                      {selectedThread.channelId} · {selectedThread.messageCount}{' '}
                      messages · updated{' '}
                      {formatRelativeTime(selectedThread.lastActive)}
                    </p>
                  </div>
                </div>

                <div className="mailbox-message-list">
                  {historyQuery.isLoading ? (
                    <div className="empty-state">Loading thread…</div>
                  ) : historyQuery.isError ? (
                    <div className="empty-state error">
                      {(historyQuery.error as Error).message}
                    </div>
                  ) : messages.length === 0 ? (
                    <div className="empty-state">
                      No stored email messages were found for this thread yet.
                    </div>
                  ) : (
                    messages.map((message) => {
                      const isAssistant =
                        String(message.role || '').toLowerCase() ===
                        'assistant';
                      return (
                        <article
                          key={message.id}
                          className={
                            isAssistant
                              ? 'mailbox-message-card assistant'
                              : 'mailbox-message-card user'
                          }
                        >
                          <div className="mailbox-message-header">
                            <div>
                              <strong>
                                {messageAuthorLabel(message, selectedThread)}
                              </strong>
                              <small>
                                {messageMetaLabel(message, selectedThread)}
                              </small>
                            </div>
                            <span>{formatDateTime(message.created_at)}</span>
                          </div>
                          <div className="mailbox-message-body">
                            {stripInlineSubject(message.content) ||
                              '(empty message)'}
                          </div>
                        </article>
                      );
                    })
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      </Panel>
    </div>
  );
}
