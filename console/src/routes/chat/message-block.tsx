import {
  memo,
  startTransition,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchArtifactBlob } from '../../api/chat';
import type { ChatArtifact, ChatMessage } from '../../api/chat-types';
import type { ApprovalAction } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import { renderMarkdown } from '../../lib/markdown';
import css from './chat-page.module.css';
import type { ChatUiMessage } from './chat-ui-message';

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

const STREAM_MARKDOWN_RENDER_INTERVAL_MS = 120;

function useRenderedMarkdown(
  content: string,
  enabled: boolean,
  isStreaming: boolean,
): string {
  const [streamedContent, setStreamedContent] = useState(content);
  const latestContentRef = useRef(content);
  const timerRef = useRef<number | null>(null);

  latestContentRef.current = content;

  useEffect(() => {
    if (!enabled) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setStreamedContent('');
      return;
    }

    if (!isStreaming) {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      setStreamedContent(content);
      return;
    }

    if (timerRef.current !== null || content === streamedContent) return;

    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      startTransition(() => {
        setStreamedContent(latestContentRef.current);
      });
    }, STREAM_MARKDOWN_RENDER_INTERVAL_MS);
  }, [content, enabled, isStreaming, streamedContent]);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  const markdownSource = enabled
    ? isStreaming
      ? streamedContent
      : content
    : '';
  return useMemo(
    () => (enabled ? renderMarkdown(markdownSource) : ''),
    [enabled, markdownSource],
  );
}

function ArtifactCard(props: { artifact: ChatArtifact; token: string }) {
  const { artifact, token } = props;
  const previewUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const isImage = (artifact.mimeType ?? '').startsWith('image/');

  useEffect(() => {
    const previousUrl = previewUrlRef.current;
    previewUrlRef.current = null;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setPreviewUrl(null);

    if (!isImage || !artifact.path) return;

    let cancelled = false;
    void fetchArtifactBlob(token, artifact.path)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(blob);
        previewUrlRef.current = objectUrl;
        setPreviewUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setPreviewUrl(null);
      });

    return () => {
      cancelled = true;
      const objectUrl = previewUrlRef.current;
      previewUrlRef.current = null;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.path, isImage, token]);

  const downloadLabel = downloading ? 'Downloading…' : 'Download';
  const handleDownload = async () => {
    if (!artifact.path || downloading) return;

    setDownloading(true);
    try {
      const objectUrl =
        previewUrl ??
        URL.createObjectURL(await fetchArtifactBlob(token, artifact.path));
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = artifact.filename ?? 'artifact';
      link.rel = 'noopener noreferrer';
      document.body.appendChild(link);
      link.click();
      link.remove();

      if (!previewUrl) {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
      }
    } catch {
      // Auth failures still dispatch globally via fetchArtifactBlob.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div className={css.artifactCard}>
      <span className={css.artifactFilename}>
        {artifact.filename ?? 'artifact'}
      </span>
      {artifact.type ? (
        <span className={css.artifactBadge}>{artifact.type}</span>
      ) : null}
      {artifact.path ? (
        <button
          type="button"
          className={css.artifactDownload}
          disabled={downloading}
          onClick={() => {
            void handleDownload();
          }}
        >
          {downloadLabel}
        </button>
      ) : null}
      {isImage && previewUrl ? (
        <div className={css.artifactPreview}>
          <img src={previewUrl} alt={artifact.filename ?? 'preview'} />
        </div>
      ) : null}
    </div>
  );
}

export const MessageBlock = memo(function MessageBlock(props: {
  message: ChatUiMessage;
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

  const handleCopy = () => {
    props.onCopy(msg.rawContent ?? msg.content);
    setCopied(true);
    setTimeout(() => setCopied(false), 900);
  };

  const artifactEntries = useMemo(() => {
    const seenKeys = new Map<string, number>();
    return (msg.artifacts ?? []).map((artifact) => {
      const parts = [
        artifact.path,
        artifact.filename,
        artifact.mimeType,
        artifact.type,
      ].filter(Boolean);
      const baseKey = parts.length > 0 ? parts.join('|') : 'artifact';
      const seenCount = seenKeys.get(baseKey) ?? 0;
      seenKeys.set(baseKey, seenCount + 1);
      return {
        artifact,
        key: `${baseKey}:${seenCount}`,
      };
    });
  }, [msg.artifacts]);

  const isMarkdownMessage =
    msg.role === 'assistant' ||
    msg.role === 'approval' ||
    Boolean(msg.pendingApproval);
  const renderedHtml = useRenderedMarkdown(
    msg.content,
    isMarkdownMessage,
    props.isStreaming,
  );

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
    (isAssistant || isApproval) && css.bubbleAssistant,
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
            // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown output is rendered by marked and sanitized through sanitize-html
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

      {artifactEntries.map(({ artifact, key }) => (
        <ArtifactCard key={key} artifact={artifact} token={token} />
      ))}

      {!props.isStreaming ? (
        <div className={css.messageActions}>
          <button
            type="button"
            className={cx(css.actionButton, copied && css.actionButtonSuccess)}
            title="Copy"
            aria-label={copied ? 'Copied' : 'Copy message'}
            onClick={handleCopy}
          >
            {copied ? '✓' : '⧉'}
          </button>
          {isUser ? (
            <button
              type="button"
              className={css.actionButton}
              title="Edit"
              aria-label="Edit message"
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
              aria-label="Regenerate response"
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
                aria-label="Previous branch"
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
                aria-label="Next branch"
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
        aria-label="Edit message"
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
