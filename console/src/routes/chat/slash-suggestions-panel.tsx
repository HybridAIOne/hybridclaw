import { type ReactNode, type Ref, useEffect } from 'react';
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
  emptyQuery: string;
  listboxId: string;
  optionId: (i: number) => string;
  listboxRef: Ref<HTMLDivElement>;
  onSelect: (item: ChatCommandSuggestion) => void;
  onActiveChange: (i: number) => void;
}

export function SlashSuggestionsPanel({
  mode,
  suggestions,
  activeIdx,
  query,
  emptyQuery,
  listboxId,
  optionId,
  listboxRef,
  onSelect,
  onActiveChange,
}: SlashSuggestionsPanelProps) {
  useEffect(() => {
    if (mode !== 'list' || suggestions.length === 0) return;
    if (typeof listboxRef !== 'object' || listboxRef === null) return;
    const list = listboxRef.current;
    const active = document.getElementById(optionId(activeIdx));
    if (!list || !active || !list.contains(active)) return;
    const top = active.offsetTop;
    const bottom = top + active.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIdx, mode, suggestions.length, listboxRef, optionId]);

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
          ref={listboxRef}
          id={listboxId}
          role="listbox"
          aria-label="Slash commands"
          className={css.slashSuggestionsList}
        >
          {mode === 'list' ? (
            suggestions.map((item, i) => (
              <div
                key={item.id}
                id={optionId(i)}
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
              No commands match “/{emptyQuery}”
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

/**
 * Locate the slash-token at `cursor`. Returns the query (text after the
 * leading `/`) plus the token bounds in `value`. Returns null when the
 * cursor is not on a slash-token, so the caller can close the panel.
 *
 * A slash-token starts at the start of `value` or right after whitespace,
 * and ends at the next whitespace or end of `value`. This lets the panel
 * trigger mid-line (e.g. `hello /clear`), not only at column 0.
 */
export function getSlashContext(
  value: string,
  cursor: number,
): { query: string; tokenStart: number; tokenEnd: number } | null {
  const before = value.slice(0, cursor);
  const wsIdx = Math.max(
    before.lastIndexOf(' '),
    before.lastIndexOf('\n'),
    before.lastIndexOf('\t'),
  );
  const tokenStart = wsIdx + 1;
  const after = value.slice(cursor);
  const nextWsRel = after.search(/\s/);
  const tokenEnd = nextWsRel === -1 ? value.length : cursor + nextWsRel;
  const token = value.slice(tokenStart, tokenEnd);
  if (!token.startsWith('/')) return null;
  return { query: token.slice(1), tokenStart, tokenEnd };
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
  if (!q) {
    return (
      <span key={`s${segIdx}`} className={className}>
        {text}
      </span>
    );
  }
  const lower = text.toLowerCase();
  const idx = lower.indexOf(q);
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
