import { type ReactNode, useEffect, useRef, useState } from 'react';
import { fetchAgentAvatarBlob } from '../../api/chat';
import type { ChatCommandSuggestion } from '../../api/chat-types';
import { PopoverContent } from '../../components/popover';
import {
  ScrollArea,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '../../components/scroll-area';
import { cx } from '../../lib/cx';
import css from './chat-page.module.css';

export type SlashPanelMode = 'closed' | 'list' | 'empty';

export interface SlashSuggestionsPanelProps {
  mode: Exclude<SlashPanelMode, 'closed'>;
  kind?: 'slash' | 'agent';
  suggestions: ChatCommandSuggestion[];
  activeIdx: number;
  query: string;
  listboxId: string;
  token?: string;
  onSelect: (item: ChatCommandSuggestion) => void;
  onActiveChange: (i: number) => void;
}

export function optionIdFor(listboxId: string, i: number): string {
  return `${listboxId}-opt-${i}`;
}

export function SlashSuggestionsPanel({
  mode,
  kind = 'slash',
  suggestions,
  activeIdx,
  query,
  listboxId,
  token,
  onSelect,
  onActiveChange,
}: SlashSuggestionsPanelProps) {
  useEffect(() => {
    if (mode !== 'list' || suggestions.length === 0) return;
    const active = document.getElementById(optionIdFor(listboxId, activeIdx));
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, mode, suggestions.length, listboxId]);

  const q = query.trim().toLowerCase();
  const trigger = kind === 'agent' ? '@' : '/';
  const listLabel = kind === 'agent' ? 'Agents' : 'Slash commands';
  const emptyLabel =
    kind === 'agent'
      ? `No agents match ${trigger}${query}`
      : `No commands match ${trigger}${query}`;

  return (
    <PopoverContent
      side="top"
      focusOnOpen="none"
      closeOnEscape={false}
      closeOnOutsideClick
      sideOffset={4}
      className={css.slashSuggestions}
    >
      <ScrollArea className={css.slashSuggestionsScroll}>
        <ScrollAreaViewport
          id={listboxId}
          role="listbox"
          aria-label={listLabel}
          className={css.slashSuggestionsList}
        >
          {mode === 'list' ? (
            suggestions.map((item, i) => (
              <div
                key={item.id}
                id={optionIdFor(listboxId, i)}
                className={cx(
                  css.suggestionItem,
                  kind === 'agent' && css.suggestionItemAgent,
                  i === activeIdx && css.suggestionItemActive,
                  (item.depth ?? 1) >= 2 && css.suggestionItemSub,
                )}
                role="option"
                tabIndex={-1}
                aria-selected={i === activeIdx}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item);
                }}
                onMouseEnter={() => onActiveChange(i)}
                title={item.description || undefined}
              >
                {kind === 'agent' ? (
                  <AgentSuggestionAvatar item={item} token={token} />
                ) : null}
                <span className={css.suggestionText}>
                  <span className={css.suggestionLabel}>
                    {renderLabel(item.label, q)}
                  </span>
                  {item.description ? (
                    <span className={css.suggestionDesc}>
                      {item.description}
                    </span>
                  ) : null}
                </span>
              </div>
            ))
          ) : (
            <div className={css.suggestionEmpty} role="status">
              {emptyLabel}
            </div>
          )}
        </ScrollAreaViewport>
        <ScrollAreaScrollbar>
          <ScrollAreaThumb />
        </ScrollAreaScrollbar>
      </ScrollArea>
    </PopoverContent>
  );
}

function AgentSuggestionAvatar(props: {
  item: ChatCommandSuggestion;
  token?: string;
}) {
  const objectUrlRef = useRef<string | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const imageUrl = props.item.imageUrl?.trim();

  useEffect(() => {
    const previous = objectUrlRef.current;
    objectUrlRef.current = null;
    if (previous) URL.revokeObjectURL(previous);
    setObjectUrl(null);

    if (!props.token || !imageUrl) return;

    let cancelled = false;
    void fetchAgentAvatarBlob(props.token, imageUrl)
      .then((blob) => {
        if (cancelled) return;
        const next = URL.createObjectURL(blob);
        objectUrlRef.current = next;
        setObjectUrl(next);
      })
      .catch(() => {
        if (!cancelled) setObjectUrl(null);
      });

    return () => {
      cancelled = true;
      const next = objectUrlRef.current;
      objectUrlRef.current = null;
      if (next) URL.revokeObjectURL(next);
    };
  }, [imageUrl, props.token]);

  const initial = props.item.label.replace(/^@/u, '').charAt(0).toUpperCase();
  return objectUrl ? (
    <img className={css.suggestionAvatar} src={objectUrl} alt="" />
  ) : (
    <span className={css.suggestionAvatarFallback} aria-hidden="true">
      {initial || '@'}
    </span>
  );
}

const PLACEHOLDER_RE = /<[^>]+>|\[[^\]]+\]/g;

function renderLabel(label: string, q: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let last = 0;
  let key = 0;
  const push = (text: string, mono: boolean) => {
    if (!text) return;
    const className = mono ? css.suggestionLabelMono : undefined;
    const idx = q ? text.toLowerCase().indexOf(q) : -1;
    nodes.push(
      idx === -1 ? (
        <span key={key++} className={className}>
          {text}
        </span>
      ) : (
        <span key={key++} className={className}>
          {text.slice(0, idx)}
          <mark className={css.suggestionMatch}>
            {text.slice(idx, idx + q.length)}
          </mark>
          {text.slice(idx + q.length)}
        </span>
      ),
    );
  };
  for (const match of label.matchAll(PLACEHOLDER_RE)) {
    const idx = match.index ?? 0;
    push(label.slice(last, idx), false);
    push(match[0], true);
    last = idx + match[0].length;
  }
  push(label.slice(last), false);
  return nodes;
}
