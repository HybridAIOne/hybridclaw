import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { fetchA2AInbox } from '../api/client';
import type {
  AdminA2AThreadMessage,
  AdminA2AThreadSummary,
} from '../api/types';
import { useAuth } from '../auth';
import { PageHeader } from '../components/ui';
import { getErrorMessage } from '../lib/error-message';
import { formatDateTime, formatRelativeTime } from '../lib/format';

function threadPreview(thread: AdminA2AThreadSummary): string {
  const content = thread.latestMessage?.content.replace(/\s+/g, ' ').trim();
  if (!content) return 'No message content';
  return content.length > 140 ? `${content.slice(0, 137)}...` : content;
}

function participantLabel(thread: AdminA2AThreadSummary): string {
  if (thread.participants.length === 0) return 'No participants';
  if (thread.participants.length <= 2) return thread.participants.join(' -> ');
  return `${thread.participants.slice(0, 2).join(' -> ')} +${
    thread.participants.length - 2
  }`;
}

function messageCountLabel(count: number): string {
  return `${count} message${count === 1 ? '' : 's'}`;
}

function intentClassName(intent: AdminA2AThreadMessage['intent']): string {
  return intent === 'escalate' || intent === 'policy.update'
    ? 'mailbox-role-pill needs-reply'
    : 'mailbox-role-pill replied';
}

function ThreadMessageCard(props: { message: AdminA2AThreadMessage }) {
  const { message } = props;
  return (
    <article className="mailbox-message-card user">
      <div className="mailbox-message-header">
        <div>
          <strong>{message.senderAgentId}</strong>
          <small>To: {message.recipientAgentId}</small>
          <small>{formatDateTime(message.createdAt)}</small>
        </div>
        <span>{message.intent}</span>
      </div>
      <div className="mailbox-message-metadata">
        <small>{message.id}</small>
        {message.parentMessageId ? (
          <small>Parent: {message.parentMessageId}</small>
        ) : null}
      </div>
      <div className="mailbox-message-body">{message.content}</div>
    </article>
  );
}

export function A2AInboxPage() {
  const auth = useAuth();
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);

  const inboxQuery = useQuery({
    queryKey: ['a2a-inbox', auth.token, selectedThreadId],
    queryFn: () => fetchA2AInbox(auth.token, selectedThreadId),
  });

  const threads = inboxQuery.data?.threads || [];
  const effectiveThreadId =
    selectedThreadId || inboxQuery.data?.selectedThreadId || null;
  const selectedThread =
    threads.find((thread) => thread.id === effectiveThreadId) || null;
  const messages = inboxQuery.data?.messages || [];

  return (
    <div className="page-stack">
      <PageHeader title="A2A Inbox" />
      <div className="mailbox-shell a2a-inbox-shell">
        <section className="mailbox-main">
          <div className="mailbox-column-header">
            <div>
              <strong>Threads</strong>
              <small>
                {inboxQuery.isLoading && !inboxQuery.data
                  ? 'Loading threads...'
                  : `${threads.length} total`}
              </small>
            </div>
          </div>

          <div className="mailbox-thread-list">
            {inboxQuery.isLoading && !inboxQuery.data ? (
              <div className="empty-state">Loading A2A threads...</div>
            ) : inboxQuery.isError ? (
              <div className="empty-state error">
                {getErrorMessage(inboxQuery.error)}
              </div>
            ) : threads.length === 0 ? (
              <div className="empty-state">No A2A threads recorded.</div>
            ) : (
              threads.map((thread) => {
                const latest = thread.latestMessage;
                const isActive = thread.id === effectiveThreadId;
                return (
                  <div
                    key={thread.id}
                    className={[
                      'mailbox-thread-row',
                      isActive ? 'is-unread' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <button
                      className="mailbox-thread-button"
                      type="button"
                      onClick={() => setSelectedThreadId(thread.id)}
                    >
                      <div className="mailbox-thread-summary">
                        <strong className="mailbox-thread-sender">
                          {thread.id}
                        </strong>
                        <span className="mailbox-thread-separator">-</span>
                        <strong className="mailbox-thread-subject">
                          {latest?.intent || 'thread'}
                        </strong>
                        <span className="mailbox-thread-separator">-</span>
                        <span className="mailbox-thread-preview">
                          {threadPreview(thread)}
                        </span>
                      </div>
                      <span className="mailbox-thread-time">
                        {latest?.createdAt
                          ? formatRelativeTime(latest.createdAt)
                          : 'unknown'}
                      </span>
                    </button>
                  </div>
                );
              })
            )}
          </div>
        </section>

        <section className="mailbox-detail">
          {selectedThread ? (
            <>
              <div className="mailbox-detail-header">
                <div className="mailbox-detail-copy">
                  <div className="mailbox-detail-heading">
                    <h3>{selectedThread.id}</h3>
                    {selectedThread.latestMessage ? (
                      <span
                        className={intentClassName(
                          selectedThread.latestMessage.intent,
                        )}
                      >
                        {selectedThread.latestMessage.intent}
                      </span>
                    ) : null}
                  </div>
                  <p className="supporting-text">
                    {participantLabel(selectedThread)} ·{' '}
                    {messageCountLabel(selectedThread.messageCount)}
                  </p>
                  {selectedThread.latestMessage ? (
                    <p className="supporting-text">
                      Last message:{' '}
                      {formatDateTime(selectedThread.latestMessage.createdAt)}
                    </p>
                  ) : null}
                </div>
              </div>

              <div className="mailbox-message-list">
                {inboxQuery.isFetching && !inboxQuery.data ? (
                  <div className="empty-state">Loading messages...</div>
                ) : messages.length === 0 ? (
                  <div className="empty-state">No messages in this thread.</div>
                ) : (
                  messages.map((message) => (
                    <ThreadMessageCard key={message.id} message={message} />
                  ))
                )}
              </div>
            </>
          ) : (
            <div className="empty-state mailbox-detail-empty">
              Select an A2A thread.
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
