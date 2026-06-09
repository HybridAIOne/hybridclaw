import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchAgentAvatarBlob, fetchArtifactBlob } from '../../api/chat';
import type {
  ChatArtifact,
  ChatMessage,
  ResponseRatingValue,
} from '../../api/chat-types';
import { Button } from '../../components/button';
import { ThumbsDown, ThumbsUp } from '../../components/icons';
import { type ApprovalAction, copyToClipboard } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import { renderMarkdown } from '../../lib/markdown';
import { ApprovalCard } from './approval-card';
import css from './chat-page.module.css';
import type { ChatUiMessage } from './chat-ui-message';

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
    () =>
      enabled
        ? // Skip syntax highlighting mid-stream; the full highlight runs once
          // when streaming finishes, instead of on every ~120ms tick.
          renderMarkdown(markdownSource, { highlight: !isStreaming })
        : '',
    [enabled, markdownSource, isStreaming],
  );
}

const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';
const CHECK_ICON =
  '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';
// `</>` code glyph shown before the language name.
const CODE_ICON =
  '<svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 7-5 5 5 5"/><path d="m15 7 5 5-5 5"/><path d="m13.5 5-3 14"/></svg>';

// Attach a hover-revealed copy button to each <pre> in a code block. The
// markdown is injected via dangerouslySetInnerHTML, so React owns that subtree
// and re-applies it on its own schedule (re-renders, streaming updates) without
// our render effect re-running. A one-shot effect that appends buttons gets its
// buttons silently wiped on the next React commit. Instead we watch the
// container with a MutationObserver and (idempotently) re-decorate any <pre>
// that's missing a button — so buttons survive every re-commit.
// Generic plaintext fence markers carry no language info; labelling them just
// adds noise, so they're treated as "no label".
const GENERIC_FENCE_LANGS = new Set(['text', 'plaintext', 'plain', 'txt']);

// The fenced language is carried on the <code> element as `language-<lang>`
// (set by the markdown renderer). Pull it back out for the corner label.
function codeBlockLanguage(pre: HTMLElement): string {
  const code = pre.querySelector('code');
  const lang = code?.className.match(/language-([\w#.+-]+)/)?.[1] ?? '';
  return GENERIC_FENCE_LANGS.has(lang) ? '' : lang;
}

function decorateCodeBlock(pre: HTMLElement): void {
  if (pre.querySelector('button[data-copy-btn]')) return;

  // Small always-visible language tag (code glyph + name) in the header strip.
  const language = codeBlockLanguage(pre);
  if (language) {
    pre.classList.add(css.codeBlockLabeled);
    const label = document.createElement('span');
    label.className = css.codeLangLabel;
    label.setAttribute('aria-hidden', 'true');
    label.innerHTML = CODE_ICON;
    const name = document.createElement('span');
    name.textContent = language;
    label.appendChild(name);
    pre.appendChild(label);
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.dataset.copyBtn = '';
  button.className = css.codeCopyButton;
  button.innerHTML = COPY_ICON;
  // aria-label (screen readers) and title (hover tooltip) are kept in sync. A
  // native title is used instead of a CSS tooltip because the <pre> clips
  // overflow, which would crop a styled tooltip at the block's corner.
  const setHint = (text: string) => {
    button.setAttribute('aria-label', text);
    button.title = text;
  };
  setHint('Copy code');
  let resetTimer: number | null = null;
  button.addEventListener('click', () => {
    const code = pre.querySelector('code');
    void copyToClipboard((code ?? pre).textContent ?? '').then((copied) => {
      // Only show the "copied" confirmation when the write actually succeeded.
      if (!copied) return;
      button.innerHTML = CHECK_ICON;
      button.classList.add(css.codeCopyButtonDone);
      setHint('Copied');
      if (resetTimer !== null) window.clearTimeout(resetTimer);
      resetTimer = window.setTimeout(() => {
        button.innerHTML = COPY_ICON;
        button.classList.remove(css.codeCopyButtonDone);
        setHint('Copy code');
      }, 1500);
    });
  });
  pre.appendChild(button);
}

function useCodeCopyButtons() {
  const observerRef = useRef<MutationObserver | null>(null);
  // A callback ref rather than useEffect: it (re)attaches the observer whenever
  // the markdown container mounts — including when the bubble renders only after
  // content streams in — and disconnects on unmount. A mount-time useEffect
  // would miss a container that appears on a later commit.
  return useCallback((root: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;
    if (!root) return;
    const decorateAll = () => {
      for (const pre of root.querySelectorAll('pre'))
        decorateCodeBlock(pre as HTMLElement);
    };
    decorateAll();
    // Re-decorate whenever React (re-)commits the markdown subtree. Appending a
    // button is idempotent (guarded by [data-copy-btn]), so the observer settles
    // after one no-op pass and never loops.
    const observer = new MutationObserver(decorateAll);
    observer.observe(root, { childList: true, subtree: true });
    observerRef.current = observer;
  }, []);
}

function buildPreviewBlob(blob: Blob, mimeType: string): Blob {
  const normalizedMimeType = mimeType.split(';')[0]?.trim().toLowerCase() || '';
  if (!normalizedMimeType) return blob;
  if (
    normalizedMimeType !== 'application/pdf' &&
    !normalizedMimeType.startsWith('image/') &&
    !normalizedMimeType.startsWith('video/')
  ) {
    return blob;
  }
  if (blob.type.toLowerCase() === normalizedMimeType) return blob;
  return new Blob([blob], { type: normalizedMimeType });
}

function ArtifactCard(props: { artifact: ChatArtifact; token: string }) {
  const { artifact, token } = props;
  const previewUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const mimeType = (artifact.mimeType ?? '').toLowerCase();
  const artifactName = artifact.filename ?? 'artifact';
  const isImage = mimeType.startsWith('image/');
  const isVideo =
    mimeType.startsWith('video/') ||
    /\.(mp4|m4v|mov|webm)$/i.test(artifact.filename ?? '') ||
    /\.(mp4|m4v|mov|webm)$/i.test(artifact.path ?? '');
  const isPdf =
    mimeType === 'application/pdf' ||
    /\.pdf$/i.test(artifact.filename ?? '') ||
    /\.pdf$/i.test(artifact.path ?? '');
  const canPreview = isImage || isVideo || isPdf;

  useEffect(() => {
    const previousUrl = previewUrlRef.current;
    previewUrlRef.current = null;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setPreviewUrl(null);

    if (!canPreview || !artifact.path) return;

    let cancelled = false;
    void fetchArtifactBlob(token, artifact.path)
      .then((blob) => {
        if (cancelled) return;
        const objectUrl = URL.createObjectURL(buildPreviewBlob(blob, mimeType));
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
  }, [artifact.path, canPreview, mimeType, token]);

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
    <div
      className={cx(
        css.artifactCard,
        previewUrl && css.artifactCardWithPreview,
      )}
    >
      <div className={css.artifactHeader}>
        <span className={css.artifactFilename}>{artifactName}</span>
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
      </div>
      {isImage && previewUrl ? (
        <div className={css.artifactPreview}>
          <img src={previewUrl} alt={artifactName} />
        </div>
      ) : null}
      {isPdf && previewUrl ? (
        <div className={cx(css.artifactPreview, css.artifactPdfPreview)}>
          <iframe
            src={previewUrl}
            title={`${artifactName} preview`}
            sandbox=""
          />
        </div>
      ) : null}
      {isVideo && previewUrl ? (
        <div className={cx(css.artifactPreview, css.artifactVideoPreview)}>
          {/* biome-ignore lint/a11y/useMediaCaption: arbitrary user/generated artifacts may not have caption tracks available. */}
          <video controls preload="metadata" src={previewUrl}>
            <a href={previewUrl} download={artifactName}>
              Download {artifactName}
            </a>
          </video>
        </div>
      ) : null}
    </div>
  );
}

function useAuthenticatedImageUrl(params: {
  token: string;
  imageUrl?: string | null;
}): string | null {
  const objectUrlRef = useRef<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);

  useEffect(() => {
    const previousUrl = objectUrlRef.current;
    objectUrlRef.current = null;
    if (previousUrl) URL.revokeObjectURL(previousUrl);
    setObjectUrl(null);

    if (!params.imageUrl) return;

    let cancelled = false;
    void fetchAgentAvatarBlob(params.token, params.imageUrl)
      .then((blob) => {
        if (cancelled) return;
        const nextUrl = URL.createObjectURL(blob);
        objectUrlRef.current = nextUrl;
        setObjectUrl(nextUrl);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });

    return () => {
      cancelled = true;
      const nextUrl = objectUrlRef.current;
      objectUrlRef.current = null;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [params.imageUrl, params.token]);

  return objectUrl;
}

export const MessageBlock = memo(function MessageBlock(props: {
  message: ChatUiMessage;
  token: string;
  isStreaming: boolean;
  onCopy: (text: string) => void;
  onEdit: (message: ChatMessage) => void;
  onRegenerate: (message: ChatMessage) => void;
  onRate?: (message: ChatMessage, rating: ResponseRatingValue | null) => void;
  ratingBusy?: boolean;
  onApprovalAction: (action: ApprovalAction, approvalId: string) => void;
  approvalBusy: boolean;
  branchInfo: { current: number; total: number } | null;
  onBranchNav: (message: ChatMessage, direction: -1 | 1) => void;
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

  const isApproval = msg.role === 'approval';
  const shouldRenderApprovalCard = isApproval && Boolean(msg.pendingApproval);
  const isMarkdownMessage =
    msg.role === 'assistant' ||
    msg.role === 'command' ||
    (isApproval && !shouldRenderApprovalCard);
  const renderedHtml = useRenderedMarkdown(
    msg.content,
    isMarkdownMessage,
    props.isStreaming,
  );
  const markdownRef = useCodeCopyButtons();
  const presentation = msg.assistantPresentation;
  const displayName = presentation?.displayName ?? 'Assistant';
  const avatarUrl = useAuthenticatedImageUrl({
    token,
    imageUrl: presentation?.imageUrl,
  });

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
  const shouldRenderBubble =
    isUser ||
    msg.content.trim().length > 0 ||
    artifactEntries.length === 0 ||
    isApproval;

  const blockClass = cx(
    css.messageBlock,
    isUser && css.messageBlockUser,
    (isAssistant ||
      msg.role === 'system' ||
      msg.role === 'command' ||
      isApproval) &&
      css.messageBlockAssistant,
  );

  const bubbleClass = cx(
    css.bubble,
    isUser && css.bubbleUser,
    (isAssistant || isApproval) && css.bubbleAssistant,
    isApproval && css.bubbleApproval,
    msg.role === 'system' && css.bubbleSystem,
    msg.role === 'command' && css.bubbleCommand,
  );

  return (
    <div className={blockClass}>
      {isAssistant ? (
        <div className={css.agentLabel}>
          {avatarUrl ? (
            <img className={css.agentAvatar} src={avatarUrl} alt="" />
          ) : (
            <span className={css.agentInitial}>
              {displayName.charAt(0).toUpperCase()}
            </span>
          )}
          <span>{displayName}</span>
        </div>
      ) : null}

      {shouldRenderBubble ? (
        <div className={bubbleClass}>
          {shouldRenderApprovalCard && msg.pendingApproval ? (
            <ApprovalCard
              approval={msg.pendingApproval}
              busy={props.approvalBusy}
              onAction={props.onApprovalAction}
            />
          ) : isMarkdownMessage ? (
            <div
              ref={markdownRef}
              className={css.markdownContent}
              // biome-ignore lint/security/noDangerouslySetInnerHtml: markdown output is rendered by marked and sanitized through sanitize-html
              dangerouslySetInnerHTML={{ __html: renderedHtml }}
            />
          ) : (
            msg.content
          )}
        </div>
      ) : null}

      {artifactEntries.map(({ artifact, key }) => (
        <ArtifactCard key={key} artifact={artifact} token={token} />
      ))}

      {!props.isStreaming ? (
        <div className={css.messageActions}>
          {isAssistant && msg.replayRequest ? (
            <Button
              variant="ghost"
              size="icon"
              className={css.actionButton}
              title="Regenerate"
              aria-label="Regenerate response"
              onClick={() => props.onRegenerate(msg)}
            >
              ↻
            </Button>
          ) : null}
          {isAssistant ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className={cx(
                  css.actionButton,
                  msg.responseRating === 'up' && css.actionButtonSelected,
                )}
                title={
                  msg.responseRating === 'up' ? 'Clear thumbs up' : 'Thumbs up'
                }
                aria-label={
                  msg.responseRating === 'up'
                    ? 'Clear thumbs up rating'
                    : 'Rate response thumbs up'
                }
                aria-pressed={msg.responseRating === 'up'}
                data-rating-locked={msg.responseRating ? 'true' : undefined}
                disabled={
                  props.ratingBusy === true ||
                  !msg.messageId ||
                  msg.responseRating === 'down'
                }
                onClick={() =>
                  props.onRate?.(msg, msg.responseRating === 'up' ? null : 'up')
                }
              >
                <ThumbsUp
                  width="13"
                  height="13"
                  filled={msg.responseRating === 'up'}
                />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className={cx(
                  css.actionButton,
                  msg.responseRating === 'down' && css.actionButtonSelected,
                )}
                title={
                  msg.responseRating === 'down'
                    ? 'Clear thumbs down'
                    : 'Thumbs down'
                }
                aria-label={
                  msg.responseRating === 'down'
                    ? 'Clear thumbs down rating'
                    : 'Rate response thumbs down'
                }
                aria-pressed={msg.responseRating === 'down'}
                data-rating-locked={msg.responseRating ? 'true' : undefined}
                disabled={
                  props.ratingBusy === true ||
                  !msg.messageId ||
                  msg.responseRating === 'up'
                }
                onClick={() =>
                  props.onRate?.(
                    msg,
                    msg.responseRating === 'down' ? null : 'down',
                  )
                }
              >
                <ThumbsDown
                  width="13"
                  height="13"
                  filled={msg.responseRating === 'down'}
                />
              </Button>
            </>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className={cx(css.actionButton, copied && css.actionButtonSuccess)}
            title="Copy"
            aria-label={copied ? 'Copied' : 'Copy message'}
            onClick={handleCopy}
          >
            {copied ? '✓' : '⧉'}
          </Button>
          {isUser ? (
            <Button
              variant="ghost"
              size="icon"
              className={css.actionButton}
              title="Edit"
              aria-label="Edit message"
              onClick={() => props.onEdit(msg)}
            >
              ✎
            </Button>
          ) : null}
          {props.branchInfo && props.branchInfo.total > 1 ? (
            <div className={css.branchSwitcher}>
              <Button
                variant="ghost"
                size="icon"
                className={css.branchButton}
                aria-label="Previous branch"
                disabled={props.branchInfo.current <= 1}
                onClick={() => props.onBranchNav(msg, -1)}
              >
                ‹
              </Button>
              <span>
                {props.branchInfo.current}/{props.branchInfo.total}
              </span>
              <Button
                variant="ghost"
                size="icon"
                className={css.branchButton}
                aria-label="Next branch"
                disabled={props.branchInfo.current >= props.branchInfo.total}
                onClick={() => props.onBranchNav(msg, 1)}
              >
                ›
              </Button>
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
        <Button
          onClick={() => props.onSave(value.trim())}
          disabled={!value.trim()}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={props.onCancel}>
          Cancel
        </Button>
      </div>
    </>
  );
}
