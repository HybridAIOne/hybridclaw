import { type ReactNode, useEffect, useRef } from 'react';
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
  suggestions: ChatCommandSuggestion[];
  activeIdx: number;
  query: string;
  listboxId: string;
  onSelect: (item: ChatCommandSuggestion) => void;
  onActiveChange: (i: number) => void;
}

export function optionIdFor(listboxId: string, i: number): string {
  return `${listboxId}-opt-${i}`;
}

export function SlashSuggestionsPanel({
  mode,
  suggestions,
  activeIdx,
  query,
  listboxId,
  onSelect,
  onActiveChange,
}: SlashSuggestionsPanelProps) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (mode !== 'list' || suggestions.length === 0) return;
    const list = viewportRef.current;
    const active = document.getElementById(optionIdFor(listboxId, activeIdx));
    if (!list || !active || !list.contains(active)) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIdx, mode, suggestions.length, listboxId]);

  return (
    <PopoverContent
      focusOnOpen="none"
      closeOnEscape={false}
      closeOnOutsideClick
      sideOffset={4}
      className={css.slashSuggestions}
    >
      <ScrollArea className={css.slashSuggestionsScroll}>
        <ScrollAreaViewport
          ref={viewportRef}
          id={listboxId}
          role="listbox"
          aria-label="Slash commands"
          className={css.slashSuggestionsList}
        >
          {mode === 'list' ? (
            suggestions.map((item, i) => (
              <div
                key={item.id}
                id={optionIdFor(listboxId, i)}
                className={cx(
                  css.suggestionItem,
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
              >
                <span className={css.suggestionLabel}>
                  {renderLabel(item.label, query)}
                </span>
                {item.description ? (
                  <span className={css.suggestionDesc}>{item.description}</span>
                ) : null}
              </div>
            ))
          ) : (
            <div className={css.suggestionEmpty} role="status">
              No commands match “/{query}”
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

const PLACEHOLDER_RE = /<[^>]+>|\[[^\]]+\]/g;

function renderLabel(label: string, query: string): ReactNode[] {
  const segments: { text: string; mono: boolean }[] = [];
  let last = 0;
  for (const match of label.matchAll(PLACEHOLDER_RE)) {
    const idx = match.index ?? 0;
    if (idx > last) {
      segments.push({ text: label.slice(last, idx), mono: false });
    }
    segments.push({ text: match[0], mono: true });
    last = idx + match[0].length;
  }
  if (last < label.length) {
    segments.push({ text: label.slice(last), mono: false });
  }
  const q = query.trim().toLowerCase();
  return segments.map((seg, i) => renderSegment(seg.text, seg.mono, q, i));
}

function renderSegment(
  text: string,
  mono: boolean,
  q: string,
  segIdx: number,
): ReactNode {
  const className = mono ? css.suggestionLabelMono : undefined;
  const idx = q ? text.toLowerCase().indexOf(q) : -1;
  if (idx === -1) {
    return (
      <span key={`s${segIdx}`} className={className}>
        {text}
      </span>
    );
  }
  return (
    <span key={`s${segIdx}`} className={className}>
      {text.slice(0, idx)}
      <mark className={css.suggestionMatch}>
        {text.slice(idx, idx + q.length)}
      </mark>
      {text.slice(idx + q.length)}
    </span>
  );
}
