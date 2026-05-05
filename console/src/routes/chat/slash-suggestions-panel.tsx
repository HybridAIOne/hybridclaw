import { type ReactNode, useEffect } from 'react';
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
  useEffect(() => {
    if (mode !== 'list' || suggestions.length === 0) return;
    const active = document.getElementById(optionIdFor(listboxId, activeIdx));
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx, mode, suggestions.length, listboxId]);

  const q = query.trim().toLowerCase();

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
                title={item.description || undefined}
              >
                <span className={css.suggestionLabel}>
                  {renderLabel(item.label, q)}
                </span>
                {item.description ? (
                  <span className={css.suggestionDesc}>{item.description}</span>
                ) : null}
              </div>
            ))
          ) : (
            <div className={css.suggestionEmpty} role="status">
              No commands match /{query}
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
