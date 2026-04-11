import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useDeferredValue, useEffect, useState } from 'react';
import {
  deleteAdminEmailMessage,
  fetchAdminEmailFolder,
  fetchAdminEmailMailbox,
  fetchAdminEmailMessage,
  fetchConfig,
} from '../api/client';
import type {
  AdminEmailFolder,
  AdminEmailMessageDetail,
  AdminEmailMessageSummary,
} from '../api/types';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';
import { formatDateTime, formatRelativeTime } from '../lib/format';

const MAILBOX_MESSAGE_LIMIT = 40;
const MAILBOX_THREAD_PREVIEW_MAX_LENGTH = 72;
const MAILBOX_REFRESH_INTERVAL_MS = 10_000;
const TOKEN_COUNT_FORMATTER = new Intl.NumberFormat();

function isDraftFolder(folder: AdminEmailFolder): boolean {
  const specialUse = String(folder.specialUse || '').toLowerCase();
  const name = folder.name.toLowerCase();
  return specialUse === '\\drafts' || name.includes('draft');
}

function folderCountValue(folder: AdminEmailFolder): string | null {
  if (folder.unseen > 0) return String(folder.unseen);
  if (isDraftFolder(folder) && folder.total > 0) return String(folder.total);
  return null;
}

function folderIcon(folder: AdminEmailFolder) {
  const specialUse = String(folder.specialUse || '').toLowerCase();
  const name = folder.name.toLowerCase();

  if (specialUse === '\\inbox' || name === 'inbox') {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4.25 5.5h11.5v9.25H12l-2 2-2-2H4.25V5.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (
    name.includes('later') ||
    name.includes('snooze') ||
    name.includes('zur')
  ) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <circle
          cx="10"
          cy="10"
          r="6.25"
          stroke="currentColor"
          strokeWidth="1.8"
        />
        <path
          d="M10 6.75V10l2.25 1.75"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (
    specialUse === '\\flagged' ||
    name.includes('important') ||
    name.includes('priority') ||
    name.includes('star')
  ) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="m6 5.25 6.5 4.75L6 14.75h8.25"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (specialUse === '\\sent' || name.includes('sent')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4.5 10 15.75 4.75l-2.75 10.5-3.5-3-2.75 2V10Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (isDraftFolder(folder)) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M6 3.75h5.5l2.5 2.5v10H6v-12.5Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M11.5 3.75v2.5H14"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (
    specialUse === '\\junk' ||
    name.includes('spam') ||
    name.includes('junk')
  ) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M8 3.75h4l4.25 4.25v4L12 16.25H8L3.75 12V8L8 3.75Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M10 7.25v3.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
        <circle cx="10" cy="13.2" r="0.95" fill="currentColor" />
      </svg>
    );
  }
  if (
    specialUse === '\\trash' ||
    name.includes('trash') ||
    name.includes('bin')
  ) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M6.5 6.25h7l-.65 9H7.15l-.65-9Zm1.75 0V4.75h3.5v1.5"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (specialUse === '\\archive' || name.includes('archive')) {
    return (
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path
          d="M4.25 5h11.5v3H4.25V5Zm.5 3h10.5v7.25H4.75V8Z"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinejoin="round"
        />
        <path
          d="M8 10.5h4"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M3.75 6.5h4.5l1.5 1.75h6.5v6.75H3.75V6.5Z"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function messageSelectionKey(message: { folder: string; uid: number }): string {
  return `${message.folder}:${message.uid}`;
}

function isSyntheticMessageUid(uid: number): boolean {
  return uid < 0;
}

function messageSenderLabel(message: AdminEmailMessageSummary): string {
  return message.fromName?.trim() || message.fromAddress?.trim() || 'Unknown';
}

function threadPreviewLabel(message: AdminEmailMessageSummary): string {
  const preview = String(message.preview || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!preview) return 'No preview available.';
  if (preview.length <= MAILBOX_THREAD_PREVIEW_MAX_LENGTH) return preview;
  return `${preview.slice(0, MAILBOX_THREAD_PREVIEW_MAX_LENGTH - 1).trimEnd()}…`;
}

function formatMailboxListTimestamp(raw: string | null): string {
  if (!raw) return 'Unknown';
  const timestamp = new Date(raw);
  if (Number.isNaN(timestamp.getTime())) return 'Unknown';

  const now = new Date();
  const isSameDay =
    timestamp.getFullYear() === now.getFullYear() &&
    timestamp.getMonth() === now.getMonth() &&
    timestamp.getDate() === now.getDate();
  if (isSameDay) {
    return timestamp.toLocaleTimeString([], {
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  const isSameYear = timestamp.getFullYear() === now.getFullYear();
  return timestamp.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    ...(isSameYear ? {} : { year: 'numeric' }),
  });
}

function messageMetadataRows(message: AdminEmailMessageDetail): string[] {
  const metadata = message.metadata;
  if (!metadata) return [];

  const rows: string[] = [];
  if (metadata.agentId) {
    rows.push(`Agent: ${metadata.agentId}`);
  }
  if (metadata.model) {
    rows.push(`Model: ${metadata.model}`);
  }
  if (metadata.provider) {
    rows.push(`Provider: ${metadata.provider}`);
  }
  if (metadata.totalTokens !== null) {
    rows.push(
      `Tokens: ${TOKEN_COUNT_FORMATTER.format(metadata.totalTokens)}${
        metadata.tokenSource === 'estimated' ? ' estimated' : ''
      }`,
    );
  }
  return rows;
}

function renderMessageMetadata(message: AdminEmailMessageDetail) {
  const rows = messageMetadataRows(message);
  if (rows.length === 0) return null;

  return (
    <div className="mailbox-message-metadata">
      {rows.map((row) => (
        <small key={`${message.uid}:${row}`}>{row}</small>
      ))}
    </div>
  );
}

function trashIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
      <path
        d="M6.5 6.25h7l-.65 9H7.15l-.65-9Zm1.75 0V4.75h3.5v1.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function matchesSearch(
  message: AdminEmailMessageSummary,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    message.fromName || '',
    message.fromAddress || '',
    message.subject,
    message.preview || '',
  ]
    .join(' ')
    .toLowerCase()
    .includes(needle);
}

export function EmailPage() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [selectedMessageId, setSelectedMessageId] = useState<string | null>(
    null,
  );
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(
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
    enabled: configQuery.data?.config.email.enabled === true,
    refetchInterval: MAILBOX_REFRESH_INTERVAL_MS,
  });

  const emailEnabled = configQuery.data?.config.email.enabled === true;
  const folders = mailboxQuery.data?.folders || [];

  useEffect(() => {
    const nextFolder =
      mailboxQuery.data?.defaultFolder ||
      mailboxQuery.data?.folders[0]?.path ||
      null;
    if (!nextFolder) {
      if (selectedFolder !== null) {
        setSelectedFolder(null);
      }
      return;
    }
    if (!folders.some((folder) => folder.path === selectedFolder)) {
      setSelectedFolder(nextFolder);
    }
  }, [
    folders,
    mailboxQuery.data?.defaultFolder,
    mailboxQuery.data?.folders[0]?.path,
    selectedFolder,
  ]);

  const folderMessagesQuery = useQuery({
    queryKey: [
      'admin-email-folder',
      auth.token,
      selectedFolder,
      MAILBOX_MESSAGE_LIMIT,
    ],
    queryFn: () =>
      fetchAdminEmailFolder(auth.token, {
        folder: selectedFolder || '',
        limit: MAILBOX_MESSAGE_LIMIT,
      }),
    enabled: emailEnabled && Boolean(selectedFolder),
    refetchInterval: MAILBOX_REFRESH_INTERVAL_MS,
  });

  const filteredMessages = (folderMessagesQuery.data?.messages || []).filter(
    (message) => matchesSearch(message, deferredSearch),
  );
  const selectedMessageSummary = selectedMessageId
    ? filteredMessages.find(
        (message) => messageSelectionKey(message) === selectedMessageId,
      ) || null
    : null;

  useEffect(() => {
    if (selectedMessageId === null) {
      return;
    }

    if (
      !filteredMessages.some(
        (message) => messageSelectionKey(message) === selectedMessageId,
      )
    ) {
      setSelectedMessageId(null);
    }
  }, [filteredMessages, selectedMessageId]);

  const messageDetailQuery = useQuery({
    queryKey: [
      'admin-email-message',
      auth.token,
      selectedMessageSummary?.folder,
      selectedMessageSummary?.uid,
    ],
    queryFn: () =>
      fetchAdminEmailMessage(auth.token, {
        folder: selectedMessageSummary?.folder || '',
        uid: selectedMessageSummary?.uid || 0,
      }),
    enabled: emailEnabled && Boolean(selectedMessageSummary),
    refetchInterval: MAILBOX_REFRESH_INTERVAL_MS,
  });

  const deleteMutation = useMutation({
    mutationFn: (params: { folder: string; uid: number }) =>
      deleteAdminEmailMessage(auth.token, params),
    onMutate: (params) => {
      setDeletingMessageId(messageSelectionKey(params));
    },
    onSuccess: async (_payload, params) => {
      const selectionKey = messageSelectionKey(params);
      if (selectedMessageId === selectionKey) {
        setSelectedMessageId(null);
      }
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ['admin-email-mailbox', auth.token],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            'admin-email-folder',
            auth.token,
            params.folder,
            MAILBOX_MESSAGE_LIMIT,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            'admin-email-message',
            auth.token,
            params.folder,
            params.uid,
          ],
        }),
      ]);
    },
    onSettled: () => {
      setDeletingMessageId(null);
    },
  });

  function handleDeleteMessage(params: { folder: string; uid: number }): void {
    deleteMutation.reset();
    deleteMutation.mutate(params);
  }

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

        <div className="empty-state">
          Email is currently disabled. Turn on the email channel first, then
          return to `/admin/email`.
        </div>
      </div>
    );
  }

  if (mailboxQuery.isLoading && !mailboxQuery.data) {
    return <div className="empty-state">Connecting to IMAP mailbox...</div>;
  }

  if (mailboxQuery.isError && !mailboxQuery.data) {
    return (
      <div className="empty-state error">
        {(mailboxQuery.error as Error).message}
      </div>
    );
  }

  const selectedFolderMeta =
    folders.find((folder) => folder.path === selectedFolder) ||
    folders[0] ||
    null;
  const selectedMessage = messageDetailQuery.data?.message || null;
  const selectedThread = messageDetailQuery.data?.thread || [];
  const isMessageOpen = selectedMessageSummary !== null;
  const deleteError =
    deleteMutation.error instanceof Error ? deleteMutation.error.message : null;

  return (
    <div className="page-stack">
      <PageHeader
        title="Email"
        actions={
          <input
            className="compact-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search sender, subject, preview"
          />
        }
      />

      <div className="mailbox-shell">
        <aside className="mailbox-sidebar">
          <div className="mailbox-sidebar-section">
            <div className="mailbox-folder-list">
              {folders.map((folder) => {
                const count = folderCountValue(folder);
                const isActive = selectedFolder === folder.path;
                return (
                  <button
                    key={folder.path}
                    className={[
                      'mailbox-folder-button',
                      isActive ? 'active' : '',
                      count ? 'is-emphasized' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    type="button"
                    onClick={() => {
                      setSelectedFolder(folder.path);
                      setSelectedMessageId(null);
                    }}
                  >
                    <span className="mailbox-folder-row">
                      <span className="mailbox-folder-title">
                        <span
                          className="mailbox-folder-symbol"
                          aria-hidden="true"
                        >
                          {folderIcon(folder)}
                        </span>
                        <span className="mailbox-folder-label">
                          {folder.name}
                        </span>
                      </span>
                      {count ? <strong>{count}</strong> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </aside>

        <section className="mailbox-main">
          {!isMessageOpen ? (
            <>
              <div className="mailbox-column-header">
                <div>
                  <strong>{selectedFolderMeta?.name || 'Mailbox'}</strong>
                  <small>
                    {folderMessagesQuery.isLoading && !folderMessagesQuery.data
                      ? 'Loading messages...'
                      : `${filteredMessages.length} shown`}
                  </small>
                </div>
                {selectedFolderMeta ? (
                  <span className="meta-chip">
                    {selectedFolderMeta.unseen > 0
                      ? `${selectedFolderMeta.unseen} unread`
                      : `${selectedFolderMeta.total} total`}
                  </span>
                ) : null}
              </div>
              {deleteError ? (
                <div className="mailbox-inline-error">{deleteError}</div>
              ) : null}

              <div className="mailbox-thread-list">
                {folderMessagesQuery.isLoading && !folderMessagesQuery.data ? (
                  <div className="empty-state">
                    Loading live IMAP messages...
                  </div>
                ) : folderMessagesQuery.isError ? (
                  <div className="empty-state error">
                    {(folderMessagesQuery.error as Error).message}
                  </div>
                ) : filteredMessages.length === 0 ? (
                  <div className="empty-state">
                    No IMAP messages match this folder and search.
                  </div>
                ) : (
                  filteredMessages.map((message) => (
                    <div
                      key={messageSelectionKey(message)}
                      className={[
                        'mailbox-thread-row',
                        !message.seen ? 'is-unread' : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    >
                      <button
                        className="mailbox-thread-button"
                        type="button"
                        onClick={() =>
                          setSelectedMessageId(messageSelectionKey(message))
                        }
                      >
                        <div className="mailbox-thread-summary">
                          <strong className="mailbox-thread-sender">
                            {messageSenderLabel(message)}
                          </strong>
                          <span className="mailbox-thread-separator">-</span>
                          <strong className="mailbox-thread-subject">
                            {message.subject}
                          </strong>
                          <span className="mailbox-thread-separator">-</span>
                          <span className="mailbox-thread-preview">
                            {threadPreviewLabel(message)}
                          </span>
                        </div>
                        <span className="mailbox-thread-time">
                          {formatMailboxListTimestamp(message.receivedAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        className="mailbox-icon-button mailbox-thread-delete"
                        aria-label={`Delete ${message.subject}`}
                        disabled={
                          deletingMessageId === messageSelectionKey(message) ||
                          isSyntheticMessageUid(message.uid)
                        }
                        onClick={() =>
                          handleDeleteMessage({
                            folder: message.folder,
                            uid: message.uid,
                          })
                        }
                      >
                        {trashIcon()}
                      </button>
                    </div>
                  ))
                )}
              </div>
            </>
          ) : (
            <section className="mailbox-detail">
              <div className="mailbox-detail-toolbar">
                <div className="mailbox-detail-toolbar-main">
                  <button
                    type="button"
                    className="mailbox-back-button"
                    aria-label="Back to message list"
                    onClick={() => setSelectedMessageId(null)}
                  >
                    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                      <path
                        d="M11.75 4.75 6.5 10l5.25 5.25"
                        stroke="currentColor"
                        strokeWidth="1.8"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                  <div className="mailbox-detail-toolbar-copy">
                    <strong>{selectedFolderMeta?.name || 'Mailbox'}</strong>
                    <small>
                      {selectedMessageSummary.receivedAt
                        ? formatRelativeTime(selectedMessageSummary.receivedAt)
                        : 'Selected message'}
                    </small>
                  </div>
                </div>
                <button
                  type="button"
                  className="ghost-button mailbox-detail-delete"
                  disabled={
                    deletingMessageId ===
                      messageSelectionKey(selectedMessageSummary) ||
                    isSyntheticMessageUid(selectedMessageSummary.uid)
                  }
                  onClick={() =>
                    handleDeleteMessage({
                      folder: selectedMessageSummary.folder,
                      uid: selectedMessageSummary.uid,
                    })
                  }
                >
                  <span className="mailbox-detail-delete-icon">
                    {trashIcon()}
                  </span>
                  <span>Delete</span>
                </button>
              </div>
              {deleteError ? (
                <div className="mailbox-inline-error">{deleteError}</div>
              ) : null}

              {messageDetailQuery.isLoading && !messageDetailQuery.data ? (
                <div className="empty-state mailbox-detail-empty">
                  Loading message...
                </div>
              ) : messageDetailQuery.isError ? (
                <div className="empty-state error mailbox-detail-empty">
                  {(messageDetailQuery.error as Error).message}
                </div>
              ) : !selectedMessage ? (
                <div className="empty-state mailbox-detail-empty">
                  This message is no longer available in the selected folder.
                </div>
              ) : (
                <>
                  <div className="mailbox-detail-header">
                    <div className="mailbox-detail-copy">
                      <div className="mailbox-detail-heading">
                        <h3>{selectedMessage.subject}</h3>
                        {!selectedMessage.seen ? (
                          <span className="mailbox-role-pill needs-reply">
                            Unread
                          </span>
                        ) : null}
                        {selectedMessage.answered ? (
                          <span className="mailbox-role-pill replied">
                            Answered
                          </span>
                        ) : null}
                      </div>
                      <p className="supporting-text">
                        {messageSenderLabel(selectedMessageSummary)}
                        {selectedMessage.fromAddress
                          ? ` · ${selectedMessage.fromAddress}`
                          : ''}
                        {selectedMessage.receivedAt
                          ? ` · ${formatDateTime(selectedMessage.receivedAt)}`
                          : ''}
                      </p>
                      <p className="supporting-text">
                        To:{' '}
                        {selectedMessage.to.length > 0
                          ? selectedMessage.to
                              .map(
                                (entry) =>
                                  entry.name?.trim() ||
                                  entry.address?.trim() ||
                                  'Unknown',
                              )
                              .join(', ')
                          : 'No recipients'}
                      </p>
                      {selectedMessage.cc.length > 0 ? (
                        <p className="supporting-text">
                          Cc:{' '}
                          {selectedMessage.cc
                            .map(
                              (entry) =>
                                entry.name?.trim() ||
                                entry.address?.trim() ||
                                'Unknown',
                            )
                            .join(', ')}
                        </p>
                      ) : null}
                    </div>
                  </div>

                  <div className="mailbox-message-list">
                    {selectedThread.map((message) => (
                      <article
                        key={`${message.folder}:${message.uid}`}
                        className={
                          message.uid === selectedMessage.uid
                            ? 'mailbox-message-card user is-selected'
                            : 'mailbox-message-card user'
                        }
                      >
                        <div className="mailbox-message-header">
                          <div>
                            <strong>
                              {message.fromName ||
                                message.fromAddress ||
                                'Unknown'}
                            </strong>
                            <small>
                              {message.fromAddress
                                ? message.fromAddress
                                : 'Unknown sender'}
                              {message.receivedAt
                                ? ` · ${formatDateTime(message.receivedAt)}`
                                : ''}
                            </small>
                            <small>
                              To:{' '}
                              {message.to.length > 0
                                ? message.to
                                    .map(
                                      (entry) =>
                                        entry.name?.trim() ||
                                        entry.address?.trim() ||
                                        'Unknown',
                                    )
                                    .join(', ')
                                : 'No recipients'}
                            </small>
                            {message.cc.length > 0 ? (
                              <small>
                                Cc:{' '}
                                {message.cc
                                  .map(
                                    (entry) =>
                                      entry.name?.trim() ||
                                      entry.address?.trim() ||
                                      'Unknown',
                                  )
                                  .join(', ')}
                              </small>
                            ) : null}
                          </div>
                        </div>
                        {renderMessageMetadata(message)}
                        {message.attachments.length > 0 ? (
                          <div className="mailbox-tag-list">
                            {message.attachments.map((attachment) => (
                              <span
                                key={`${message.uid}:${attachment.filename || 'attachment'}:${attachment.size || 0}`}
                                className="meta-chip"
                              >
                                {attachment.filename || 'attachment'}
                              </span>
                            ))}
                          </div>
                        ) : null}
                        <div className="mailbox-message-body">
                          {message.text || '(empty message)'}
                        </div>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
        </section>
      </div>
    </div>
  );
}
