import {
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { fetchChatCommands } from '../../api/chat';
import type { ChatCommandSuggestion, MediaItem } from '../../api/chat-types';
import { extractClipboardFiles } from '../../lib/chat-helpers';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';

function SlashSuggestions(props: {
  items: ChatCommandSuggestion[];
  activeIndex: number;
  onSelect: (item: ChatCommandSuggestion) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div className={css.slashSuggestions} role="listbox">
      {props.items.map((item, i) => (
        <div
          key={item.id}
          className={cx(
            css.suggestionItem,
            i === props.activeIndex && css.suggestionItemActive,
          )}
          role="option"
          tabIndex={-1}
          aria-selected={i === props.activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            props.onSelect(item);
          }}
        >
          <span className={css.suggestionLabel}>{item.label}</span>
          {item.description ? (
            <span className={css.suggestionDesc}>{item.description}</span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

export function Composer(props: {
  isStreaming: boolean;
  onSend: (content: string, media: MediaItem[]) => void;
  onStop: () => void;
  onUploadFiles: (files: File[]) => Promise<MediaItem[]>;
  token: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingMedia, setPendingMedia] = useState<MediaItem[]>([]);
  const [uploading, setUploading] = useState(0);
  const [suggestions, setSuggestions] = useState<ChatCommandSuggestion[]>([]);
  const [activeIdx, setActiveIdx] = useState(0);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const suggestTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suggestSeqRef = useRef(0);

  useEffect(() => {
    return () => {
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
    };
  }, []);

  const resize = () => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '24px';
    ta.style.height = `${Math.min(ta.scrollHeight, 180)}px`;
  };

  const fetchSuggestions = useCallback(
    async (query: string) => {
      suggestSeqRef.current += 1;
      const seq = suggestSeqRef.current;
      try {
        const res = await fetchChatCommands(props.token, query || undefined);
        if (seq !== suggestSeqRef.current) return;
        setSuggestions(res.commands ?? []);
        setActiveIdx(0);
        setShowSuggestions((res.commands ?? []).length > 0);
      } catch {
        if (seq !== suggestSeqRef.current) return;
        setSuggestions([]);
        setShowSuggestions(false);
      }
    },
    [props.token],
  );

  const handleInput = () => {
    resize();
    const val = textareaRef.current?.value ?? '';
    if (val.startsWith('/')) {
      const query = val.slice(1).trim();
      if (suggestTimerRef.current) clearTimeout(suggestTimerRef.current);
      suggestTimerRef.current = setTimeout(() => {
        void fetchSuggestions(query);
      }, 150);
    } else {
      setShowSuggestions(false);
    }
  };

  const applySuggestion = (item: ChatCommandSuggestion) => {
    if (!textareaRef.current) return;
    textareaRef.current.value = `${item.insertText} `;
    setShowSuggestions(false);
    resize();
    textareaRef.current.focus();
  };

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
    setPendingMedia([]);
    resize();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions && suggestions.length > 0) {
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
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        applySuggestion(suggestions[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
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

  return (
    <div className={css.composerWrapper}>
      <div className={css.composer} style={{ position: 'relative' }}>
        {showSuggestions ? (
          <SlashSuggestions
            items={suggestions}
            activeIndex={activeIdx}
            onSelect={applySuggestion}
          />
        ) : null}
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
        <div className={css.composerRow}>
          <button
            type="button"
            className={css.attachButton}
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach files"
          >
            +
          </button>
          <textarea
            ref={textareaRef}
            className={css.composerInput}
            rows={1}
            placeholder="Message HybridClaw"
            disabled={props.isStreaming}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-label="Message input"
          />
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
    </div>
  );
}
