import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { fetchChatCommands } from '../../api/chat';
import type { ChatCommandSuggestion, MediaItem } from '../../api/chat-types';
import { Popover, PopoverAnchor } from '../../components/popover';
import { extractClipboardFiles } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import { pluralize } from '../../lib/format';
import { AGENT_ADDRESS_PATTERN } from './agent-address-pattern';
import { preloadAgentAvatarUrl, useAgentAvatarUrl } from './agent-avatar-url';
import {
  type AgentSwitchOption,
  AgentSwitchSelect,
} from './agent-switch-select';
import css from './chat-page.module.css';
import {
  type ModelSwitchEntry,
  ModelSwitchSelect,
} from './model-switch-select';
import { getSlashContext } from './slash-context';
import {
  optionIdFor,
  type SlashPanelMode,
  SlashSuggestionsPanel,
} from './slash-suggestions-panel';

type SuggestionKind = 'slash' | 'agent';

interface AgentMentionContext {
  tokenStart: number;
  query: string;
}

const AGENT_MENTION_QUERY_PATTERN = '[A-Za-z0-9._-]*(?:@[A-Za-z0-9._-]*){0,2}';
const AGENT_MENTION_CONTEXT_RE = new RegExp(
  `(?:^|[\\s([{])@(${AGENT_MENTION_QUERY_PATTERN})$`,
  'u',
);
const AGENT_MENTION_TOKEN_RE = new RegExp(
  `@(${AGENT_ADDRESS_PATTERN})(?=$|[\\s:])`,
  'gu',
);
const LEADING_AGENT_ADDRESS_RE = new RegExp(
  `^@${AGENT_ADDRESS_PATTERN}(?=$|[\\s:])\\s*`,
  'u',
);

function getAgentMentionContext(
  value: string,
  cursor: number,
): AgentMentionContext | null {
  const beforeCursor = value.slice(0, cursor);
  const match = AGENT_MENTION_CONTEXT_RE.exec(beforeCursor);
  if (!match) return null;
  const query = match[1] ?? '';
  return {
    tokenStart: beforeCursor.length - query.length - 1,
    query,
  };
}

export function Composer(props: {
  isStreaming: boolean;
  onSend: (content: string, media: MediaItem[]) => void;
  onStop: () => void;
  onUploadFiles: (files: File[]) => Promise<MediaItem[]>;
  token: string;
  agents?: AgentSwitchOption[];
  selectedAgentId?: string;
  onAgentSwitch?: (agentId: string) => void;
  models?: ModelSwitchEntry[];
  selectedModelId?: string;
  onModelSwitch?: (modelId: string) => void;
  showModelSwitch?: boolean;
  initialValue?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const [pendingMedia, setPendingMedia] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(0);
  const [suggestions, setSuggestions] = useState<ChatCommandSuggestion[]>([]);
  const [suggestionKind, setSuggestionKind] = useState<SuggestionKind>('slash');
  const [activeIdx, setActiveIdx] = useState(0);
  const [panelMode, setPanelMode] = useState<SlashPanelMode>('closed');
  const [lastQuery, setLastQuery] = useState('');
  const [composerValue, setComposerValue] = useState('');
  const [composerCaretIndex, setComposerCaretIndex] = useState(0);
  const appliedInitialValueRef = useRef<string | null>(null);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionRestoreTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const suggestSeqRef = useRef(0);
  const overlayRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const isOpen = panelMode !== 'closed';
  const liveMessage =
    panelMode === 'closed'
      ? ''
      : suggestionKind === 'agent'
        ? panelMode === 'list'
          ? `${pluralize(suggestions.length, 'agent')} available`
          : `No agents match @${lastQuery}`
        : panelMode === 'list'
          ? `${pluralize(suggestions.length, 'command')} available`
          : `No commands match /${lastQuery}`;

  useEffect(() => {
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      if (selectionRestoreTimerRef.current) {
        clearTimeout(selectionRestoreTimerRef.current);
      }
      // Invalidate any in-flight fetch so its late resolve can't setState
      // on an unmounted component.
      suggestSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const updateComposerHeight = () => {
      const height = wrapper.getBoundingClientRect().height;
      if (!Number.isFinite(height) || height <= 0) return;
      document.documentElement.style.setProperty(
        '--chat-composer-height',
        `${Math.ceil(height)}px`,
      );
    };

    updateComposerHeight();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(updateComposerHeight);
    observer?.observe(wrapper);
    window.addEventListener('resize', updateComposerHeight);

    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateComposerHeight);
      document.documentElement.style.removeProperty('--chat-composer-height');
    };
  }, []);

  const wasStreamingRef = useRef(props.isStreaming);
  useEffect(() => {
    if (wasStreamingRef.current && !props.isStreaming) {
      textareaRef.current?.focus();
    }
    wasStreamingRef.current = props.isStreaming;
  }, [props.isStreaming]);

  const resize = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '36px';
    ta.style.height = `${Math.max(36, Math.min(ta.scrollHeight, 180))}px`;
  }, []);

  const syncComposerSelection = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    setComposerCaretIndex(ta.selectionStart ?? ta.value.length);
  }, []);

  const restoreComposerFocusAt = useCallback((cursor: number) => {
    const applySelection = () => {
      const ta = textareaRef.current;
      if (!ta) return;
      const nextCursor = Math.max(0, Math.min(cursor, ta.value.length));
      ta.focus();
      ta.setSelectionRange(nextCursor, nextCursor);
      setComposerCaretIndex(nextCursor);
    };

    applySelection();
    if (selectionRestoreTimerRef.current) {
      clearTimeout(selectionRestoreTimerRef.current);
    }
    selectionRestoreTimerRef.current = setTimeout(() => {
      selectionRestoreTimerRef.current = null;
      applySelection();
    }, 0);
  }, []);

  useEffect(() => {
    const nextValue = props.initialValue?.trim() || '';
    if (appliedInitialValueRef.current === nextValue) return;
    appliedInitialValueRef.current = nextValue;
    if (!nextValue) return;

    const ta = textareaRef.current;
    if (!ta) return;
    ta.value = nextValue;
    ta.setSelectionRange(nextValue.length, nextValue.length);
    setComposerValue(nextValue);
    setComposerCaretIndex(nextValue.length);
    setPanelMode('closed');
    suggestSeqRef.current += 1;
    resize();
    ta.focus();
  }, [props.initialValue, resize]);

  // The fetch itself can't be aborted, so the seq bump is what makes a
  // late-resolving response a no-op.
  const cancelPendingFetch = useCallback(() => {
    if (suggestTimerRef.current) {
      clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = null;
    }
    suggestSeqRef.current += 1;
  }, []);

  const closePanel = useCallback(() => {
    cancelPendingFetch();
    setPanelMode('closed');
  }, [cancelPendingFetch]);

  const fetchSuggestions = useCallback(
    async (query: string) => {
      // The seq is bumped by every cancel/dismiss/submit path, so we just
      // capture the current value here — any later bump invalidates this run.
      const seq = suggestSeqRef.current;
      try {
        const res = await fetchChatCommands(props.token, query || undefined);
        if (seq !== suggestSeqRef.current) return;
        const commands = res.commands ?? [];
        setSuggestions(commands);
        setActiveIdx(0);
        setLastQuery(query);
        if (commands.length > 0) {
          setPanelMode('list');
        } else if (query !== '') {
          setPanelMode('empty');
        } else {
          setPanelMode('closed');
        }
      } catch {
        if (seq !== suggestSeqRef.current) return;
        setSuggestions([]);
        setPanelMode('closed');
      }
    },
    [props.token],
  );

  const buildAgentSuggestions = useCallback(
    (query: string): ChatCommandSuggestion[] => {
      const q = query.trim().toLowerCase();
      return (props.agents ?? [])
        .filter((agent) => {
          if (!q) return true;
          return (
            agent.id.toLowerCase().includes(q) ||
            (agent.name ?? '').toLowerCase().includes(q)
          );
        })
        .map((agent) => {
          const name = agent.name?.trim();
          return {
            id: `agent:${agent.id}`,
            label: `@${agent.id}`,
            insertText: `@${agent.id}`,
            description: name && name !== agent.id ? name : '',
            imageUrl: agent.imageUrl ?? null,
          };
        });
    },
    [props.agents],
  );

  useEffect(() => {
    for (const agent of props.agents ?? []) {
      void preloadAgentAvatarUrl(props.token, agent.imageUrl);
    }
  }, [props.agents, props.token]);

  const handleInput = () => {
    resize();
    const ta = textareaRef.current;
    if (!ta) return;
    setComposerValue(ta.value);
    const cursor = ta.selectionStart ?? ta.value.length;
    setComposerCaretIndex(cursor);
    const ctx = getSlashContext(ta.value, cursor);
    if (ctx) {
      const query = ctx.query.trim();
      setSuggestionKind('slash');
      cancelPendingFetch();
      suggestTimerRef.current = setTimeout(() => {
        void fetchSuggestions(query);
      }, 150);
      return;
    }

    const agentCtx = getAgentMentionContext(ta.value, cursor);
    if (agentCtx && (props.agents?.length ?? 0) > 0) {
      cancelPendingFetch();
      const agentSuggestions = buildAgentSuggestions(agentCtx.query);
      setSuggestions(agentSuggestions);
      setSuggestionKind('agent');
      setActiveIdx(0);
      setLastQuery(agentCtx.query);
      setPanelMode(
        agentSuggestions.length > 0
          ? 'list'
          : agentCtx.query !== ''
            ? 'empty'
            : 'closed',
      );
    } else {
      closePanel();
    }
  };

  const applySuggestion = (item: ChatCommandSuggestion) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const value = ta.value;
    const cursor = ta.selectionStart ?? value.length;
    const insertCore = item.insertText.replace(/\s+$/, '');
    let nextCursor = ta.value.length;
    if (suggestionKind === 'agent') {
      const ctx = getAgentMentionContext(value, cursor);
      if (ctx) {
        const before = value.slice(0, ctx.tokenStart);
        const after = value.slice(cursor);
        const insert = after.startsWith(' ') ? insertCore : `${insertCore} `;
        ta.value = before + insert + after;
        nextCursor = before.length + insert.length;
        ta.setSelectionRange(nextCursor, nextCursor);
      } else {
        ta.value = `${insertCore} `;
        nextCursor = ta.value.length;
        ta.setSelectionRange(nextCursor, nextCursor);
      }
      setComposerValue(ta.value);
      setComposerCaretIndex(nextCursor);
      closePanel();
      resize();
      ta.focus();
      return;
    }

    const ctx = getSlashContext(value, cursor);
    if (ctx) {
      const before = value.slice(0, ctx.tokenStart);
      const after = value.slice(cursor);
      const insert = after.startsWith(' ') ? insertCore : `${insertCore} `;
      ta.value = before + insert + after;
      nextCursor = before.length + insert.length;
      ta.setSelectionRange(nextCursor, nextCursor);
    } else {
      ta.value = `${insertCore} `;
      nextCursor = ta.value.length;
      ta.setSelectionRange(nextCursor, nextCursor);
    }
    setComposerValue(ta.value);
    setComposerCaretIndex(nextCursor);
    closePanel();
    resize();
    ta.focus();
  };

  const insertAgentAddress = useCallback(
    (agentId: string) => {
      const ta = textareaRef.current;
      if (!ta) return;
      const mention = `@${agentId}`;
      const insertedPrefix = `${mention} `;
      const value = ta.value;
      const leadingMention = LEADING_AGENT_ADDRESS_RE.exec(value);
      let nextValue: string;
      if (!value.trim()) {
        nextValue = insertedPrefix;
      } else if (leadingMention) {
        nextValue = `${insertedPrefix}${value.slice(leadingMention[0].length).trimStart()}`;
      } else {
        nextValue = `${insertedPrefix}${value.trimStart()}`;
      }
      ta.value = nextValue;
      setComposerValue(ta.value);
      setComposerCaretIndex(insertedPrefix.length);
      closePanel();
      resize();
      restoreComposerFocusAt(insertedPrefix.length);
    },
    [closePanel, resize, restoreComposerFocusAt],
  );

  const submit = () => {
    if (props.isStreaming) {
      props.onStop();
      return;
    }
    const val = (textareaRef.current?.value ?? '').trim();
    if (!val && pendingMedia.length === 0) return;
    if (uploading > 0) return;
    props.onSend(val, pendingMedia);
    if (textareaRef.current) textareaRef.current.value = '';
    setComposerValue('');
    setComposerCaretIndex(0);
    setPendingMedia([]);
    closePanel();
    resize();
  };

  const handleScroll = () => {
    const ta = textareaRef.current;
    const overlay = overlayRef.current;
    if (!ta || !overlay) return;
    overlay.scrollTop = ta.scrollTop;
    overlay.scrollLeft = ta.scrollLeft;
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // While an IME is composing, all keystrokes belong to the IME (typing,
    // navigating candidates, confirming) — never to the composer UI.
    // keyCode 229 is the cross-browser fallback: Safari/WebKit fires the
    // confirming Enter with `isComposing` already false but `keyCode === 229`.
    if (e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
    if (panelMode === 'list' && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setActiveIdx(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setActiveIdx(suggestions.length - 1);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[activeIdx]);
        return;
      }
    }
    if (e.key === 'Escape') {
      // Always cancel a pending lookup so a fetch in flight when the user
      // dismisses can't pop the panel after they've moved on.
      const wasOpen = isOpen;
      closePanel();
      if (wasOpen) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const handlePaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = extractClipboardFiles(e.clipboardData);
    if (files.length > 0) {
      e.preventDefault();
      void doUpload(files);
    }
  };

  const doUpload = async (files: File[]) => {
    setUploading((n) => n + files.length);
    try {
      const uploaded = await props.onUploadFiles(files);
      if (uploaded.length > 0) {
        setPendingMedia((prev) => [...prev, ...uploaded]);
      }
    } finally {
      setUploading((n) => Math.max(0, n - files.length));
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length > 0) void doUpload(files);
    e.target.value = '';
  };

  const removeMedia = (index: number) => {
    setPendingMedia((prev) => prev.filter((_, i) => i !== index));
  };

  const agentOptions = props.agents ?? [];
  const agentById = useMemo(
    () => new Map(agentOptions.map((agent) => [agent.id, agent])),
    [agentOptions],
  );
  const selectedAgentId = props.selectedAgentId ?? '';
  const modelOptions = props.models ?? [];
  const selectedModelId = props.selectedModelId ?? '';

  return (
    <div className={css.composerWrapper} ref={wrapperRef}>
      <Popover
        open={isOpen}
        onOpenChange={(next) => {
          if (!next) closePanel();
        }}
      >
        <div className={css.composer}>
          {pendingMedia.length > 0 || uploading > 0 ? (
            <div className={css.pendingMediaRow}>
              {pendingMedia.map((m, i) => (
                <span key={m.path} className={css.mediaChip}>
                  <span className={css.mediaChipName}>{m.filename}</span>
                  <button
                    type="button"
                    className={css.mediaChipRemove}
                    onClick={() => removeMedia(i)}
                  >
                    ×
                  </button>
                </span>
              ))}
              {uploading > 0 ? (
                <span className={css.mediaChip}>Uploading…</span>
              ) : null}
            </div>
          ) : null}
          <PopoverAnchor className={css.composerInputWrap}>
            {composerValue ? (
              <div
                ref={overlayRef}
                className={css.composerInputOverlay}
                aria-hidden="true"
              >
                <ComposerInputPreview
                  value={composerValue}
                  caretIndex={composerCaretIndex}
                  agents={agentById}
                  token={props.token}
                />
              </div>
            ) : null}
            <textarea
              ref={textareaRef}
              className={cx(
                css.composerInput,
                composerValue && css.composerInputHasOverlay,
              )}
              rows={1}
              placeholder="Message HybridClaw"
              disabled={props.isStreaming}
              onInput={handleInput}
              onSelect={syncComposerSelection}
              onClick={syncComposerSelection}
              onKeyUp={syncComposerSelection}
              onFocus={syncComposerSelection}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              onScroll={handleScroll}
              aria-label="Message input"
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-controls={listboxId}
              aria-expanded={isOpen}
              aria-activedescendant={
                panelMode === 'list' && suggestions.length > 0
                  ? optionIdFor(listboxId, activeIdx)
                  : undefined
              }
            />
          </PopoverAnchor>
          <div className={css.composerActions}>
            <div className={css.composerLeftActions}>
              <button
                type="button"
                className={css.attachButton}
                onClick={() => fileInputRef.current?.click()}
                aria-label="Attach files"
              >
                +
              </button>
              <AgentSwitchSelect
                agents={agentOptions}
                selectedAgentId={selectedAgentId}
                token={props.token}
                disabled={props.isStreaming}
                onSwitch={(agent) => {
                  if (agent.source?.type === 'remote') {
                    insertAgentAddress(agent.id);
                    return;
                  }
                  props.onAgentSwitch?.(agent.id);
                }}
              />
              {props.showModelSwitch !== false ? (
                <ModelSwitchSelect
                  models={modelOptions}
                  selectedModelId={selectedModelId}
                  disabled={props.isStreaming}
                  onSwitch={(modelId) => props.onModelSwitch?.(modelId)}
                />
              ) : null}
            </div>
            <button
              type="button"
              className={cx(css.sendButton, props.isStreaming && css.stopping)}
              onClick={submit}
              aria-label={props.isStreaming ? 'Stop' : 'Send message'}
            >
              {props.isStreaming ? (
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="currentColor"
                  aria-hidden="true"
                >
                  <rect x="6" y="6" width="12" height="12" rx="2" />
                </svg>
              ) : (
                <svg
                  viewBox="0 0 24 24"
                  width="16"
                  height="16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M12 19V5" />
                  <path d="m5 12 7-7 7 7" />
                </svg>
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              hidden
              multiple
              onChange={handleFileChange}
            />
          </div>
        </div>
        {panelMode !== 'closed' ? (
          <SlashSuggestionsPanel
            mode={panelMode}
            kind={suggestionKind}
            suggestions={suggestions}
            activeIdx={activeIdx}
            query={lastQuery}
            listboxId={listboxId}
            token={props.token}
            onSelect={applySuggestion}
            onActiveChange={setActiveIdx}
          />
        ) : null}
      </Popover>
      <div
        className={css.slashLiveRegion}
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </div>
    </div>
  );
}

function ComposerInputPreview(props: {
  value: string;
  caretIndex: number;
  agents: ReadonlyMap<string, AgentSwitchOption>;
  token: string;
}) {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let caretRendered = false;
  const caretIndex = Math.max(
    0,
    Math.min(props.caretIndex, props.value.length),
  );

  const appendCaret = () => {
    if (caretRendered) return;
    parts.push(
      <span
        key={`caret-${key++}`}
        className={css.composerOverlayCaret}
        aria-hidden="true"
      />,
    );
    caretRendered = true;
  };

  const appendText = (text: string, startIndex: number) => {
    const endIndex = startIndex + text.length;
    if (caretIndex < startIndex || caretIndex > endIndex) {
      parts.push(text);
      return;
    }

    const splitAt = caretIndex - startIndex;
    if (splitAt > 0) parts.push(text.slice(0, splitAt));
    appendCaret();
    if (splitAt < text.length) parts.push(text.slice(splitAt));
  };

  for (const match of props.value.matchAll(AGENT_MENTION_TOKEN_RE)) {
    const mention = match[0];
    const agentId = match[1] ?? '';
    const index = match.index ?? 0;
    const mentionEnd = index + mention.length;
    const agent = props.agents.get(agentId);
    if (!agent) continue;
    if (index > last) appendText(props.value.slice(last, index), last);
    if (caretIndex > index && caretIndex < mentionEnd) {
      appendText(mention, index);
    } else {
      if (caretIndex === index) appendCaret();
      parts.push(
        <ComposerMentionPill
          key={`mention-${key++}`}
          mention={mention}
          imageUrl={agent.imageUrl ?? null}
          token={props.token}
        />,
      );
      if (caretIndex === mentionEnd) appendCaret();
    }
    last = mentionEnd;
  }

  if (last < props.value.length) appendText(props.value.slice(last), last);
  if (!caretRendered && caretIndex === props.value.length) appendCaret();
  return parts.length > 0 ? parts : props.value;
}

function ComposerMentionPill(props: {
  mention: string;
  imageUrl?: string | null;
  token: string;
}) {
  const avatar = useAgentAvatarUrl({
    token: props.token,
    imageUrl: props.imageUrl,
  });

  return (
    <span className={css.composerMentionPill}>
      {avatar.objectUrl ? (
        <img
          className={css.composerMentionAvatar}
          src={avatar.objectUrl}
          alt=""
        />
      ) : null}
      <span>{props.mention}</span>
    </span>
  );
}
