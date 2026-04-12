import { memo, useMemo, useState } from 'react';
import { artifactUrl } from '../../api/chat';
import type { ChatArtifact, ChatMessage } from '../../api/chat-types';
import type { ApprovalAction } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import { renderMarkdown } from '../../lib/markdown';
import css from './chat-page.module.css';

const APPROVAL_BUTTONS: ReadonlyArray<{
  label: string;
  action: ApprovalAction;
}> = [
  { label: 'Allow once', action: 'once' },
  { label: 'Allow always', action: 'always' },
  { label: 'Allow session', action: 'session' },
  { label: 'Allow agent', action: 'agent' },
  { label: 'Allow all', action: 'all' },
];

function ArtifactCard(props: { artifact: ChatArtifact; token: string }) {
  const { artifact, token } = props;
  const href = artifact.path ? artifactUrl(artifact.path, token) : undefined;
  const isImage = (artifact.mimeType ?? '').startsWith('image/');
  return (
    <div className={css.artifactCard}>
      <span className={css.artifactFilename}>
        {artifact.filename ?? 'artifact'}
      </span>
      {artifact.type ? (
        <span className={css.artifactBadge}>{artifact.type}</span>
      ) : null}
      {href ? (
        <a
          className={css.artifactDownload}
          href={href}
          target="_blank"
          rel="noopener noreferrer"
        >
          Download
        </a>
      ) : null}
      {isImage && href ? (
        <div className={css.artifactPreview}>
          <img src={href} alt={artifact.filename ?? 'preview'} />
        </div>
      ) : null}
    </div>
  );
}

export const MessageBlock = memo(function MessageBlock(props: {
  message: ChatMessage;
  token: string;
  isStreaming: boolean;
  onCopy: (text: string) => void;
  onEdit: (message: ChatMessage) => void;
  onRegenerate: (message: ChatMessage) => void;
  onApprovalAction: (action: ApprovalAction, approvalId: string) => void;
  approvalBusy: boolean;
  branchInfo: { current: number; total: number } | null;
  onBranchNav: (direction: -1 | 1) => void;
}) {
  const { message: msg, token } = props;
  const [copied, setCopied] = useState(false);

  const renderedHtml = useMemo(
    () => renderMarkdown(msg.content),
    [msg.content],
  );

  const handleCopy = () => {
    props.onCopy(msg.rawContent ?? msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 900);
  };

  if (msg.role === 'thinking') {
    return (
      <div className={css.thinking}>
        <span className={css.thinkingDot} />
        <span className={css.thinkingDot} />
        <span className={css.thinkingDot} />
      </div>
    );
  }

  const isUser = msg.role === 'user';
  const isAssistant = msg.role === 'assistant';
  const isApproval = msg.role === 'approval' || Boolean(msg.pendingApproval);

  const blockClass = cx(
    css.messageBlock,
    isUser && css.messageBlockUser,
    (isAssistant || msg.role === 'system' || isApproval) &&
      css.messageBlockAssistant,
  );

  const bubbleClass = cx(
    css.bubble,
    isUser && css.bubbleUser,
    isAssistant && css.bubbleAssistant,
    msg.role === 'system' && css.bubbleSystem,
  );

  const presentation = msg.assistantPresentation;
  const displayName = presentation?.displayName ?? 'Assistant';

  return (
    <div className={blockClass}>
      {isAssistant ? (
        <div className={css.agentLabel}>
          {presentation?.imageUrl ? (
            <img
              className={css.agentAvatar}
              src={presentation.imageUrl}
              alt=""
            />
          ) : (
            <span className={css.agentInitial}>
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
          <span>{displayName}</span>
        </div>
      ) : null}

      <div className={bubbleClass}>
        {isAssistant || isApproval ? (
          <div
            className={css.markdownContent}
            // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown output is escaped via escapeHtml + sanitizeUrl
            dangerouslySetInnerHTML={{ __html: renderedHtml }}
          />
        ) : (
          msg.content
        )}

        {isApproval && msg.pendingApproval ? (
          <div className={css.approvalActions}>
            {APPROVAL_BUTTONS.map((btn) => (
              <button
                key={btn.action}
                type="button"
                className={css.approvalAllow}
                disabled={props.approvalBusy}
                onClick={() =>
                  props.onApprovalAction(
                    btn.action,
                    msg.pendingApproval?.approvalId ?? '',
                  )
                }
              >
                {btn.label}
              </button>
            ))}
            <button
              type="button"
              className={css.approvalDeny}
              disabled={props.approvalBusy}
              onClick={() =>
                props.onApprovalAction(
                  'deny',
                  msg.pendingApproval?.approvalId ?? '',
                )
              }
            >
              Deny
            </button>
          </div>
        ) : null}
      </div>

      {(msg.artifacts ?? []).map((art) => (
        <ArtifactCard
          key={art.path ?? art.filename ?? ''}
          artifact={art}
          token={token}
        />
      ))}

      {!props.isStreaming ? (
        <div className={css.messageActions}>
          <button
            type="button"
            className={cx(css.actionButton, copied && css.actionButtonSuccess)}
            title="Copy"
            onClick={handleCopy}
          >
            {copied ? '✓' : '⧉'}
          </button>
          {isUser ? (
            <button
              type="button"
              className={css.actionButton}
              title="Edit"
              onClick={() => props.onEdit(msg)}
            >
              ✎
            </button>
          ) : null}
          {isAssistant && msg.replayRequest ? (
            <button
              type="button"
              className={css.actionButton}
              title="Regenerate"
              onClick={() => props.onRegenerate(msg)}
            >
              ↻
            </button>
          ) : null}
          {props.branchInfo && props.branchInfo.total > 1 ? (
            <div className={css.branchSwitcher}>
              <button
                type="button"
                className={css.branchButton}
                disabled={props.branchInfo.current <= 1}
                onClick={() => props.onBranchNav(-1)}
              >
                ‹
              </button>
              <span>
                {props.branchInfo.current}/{props.branchInfo.total}
              </span>
              <button
                type="button"
                className={css.branchButton}
                disabled={props.branchInfo.current >= props.branchInfo.total}
                onClick={() => props.onBranchNav(1)}
              >
                ›
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});

export function EditInline(props: {
  initial: string;
  onSave: (content: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(props.initial);
  return (
    <>
      <textarea
        className={css.editArea}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        // biome-ignore lint/a11y/noAutofocus: edit mode should focus the textarea immediately
        autoFocus
      />
      <div className={css.editButtons}>
        <button
          type="button"
          className="primary-button"
          onClick={() => props.onSave(value.trim())}
          disabled={!value.trim()}
        >
          Save
        </button>
        <button type="button" className="ghost-button" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </>
  );
}
