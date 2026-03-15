import type { GatewayHistoryMessage } from './gateway/gateway-types.js';

// biome-ignore lint/complexity/useRegexLiterals: the literal form trips noControlCharactersInRegex for these ANSI escape-code ranges.
const ANSI_ESCAPE_PATTERN = new RegExp(
  '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:[a-zA-Z\\d]*(?:;[a-zA-Z\\d]*)*)?\\u0007)|(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))',
  'g',
);
const TUI_HISTORY_FETCH_MULTIPLIER = 2;
const TUI_HISTORY_FETCH_LIMIT_CAP = 400;

function normalizeTuiHistoryEntry(content: string): string | null {
  const normalized = String(content || '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return null;
  if (normalized.includes('\n')) return null;
  return normalized;
}

export function resolveTuiHistoryFetchLimit(limit: number): number {
  const requestedEntries = Math.max(1, Math.floor(limit) || 1);
  // The gateway history API returns both user and assistant turns, while the
  // readline preload keeps only recent single-line user inputs. Cap the
  // over-fetch so a future oversized caller cannot ask the history endpoint
  // for an unbounded number of mixed turns.
  return Math.min(
    requestedEntries * TUI_HISTORY_FETCH_MULTIPLIER,
    TUI_HISTORY_FETCH_LIMIT_CAP,
  );
}

export function buildTuiReadlineHistory(
  messages: GatewayHistoryMessage[],
  maxEntries: number,
): string[] {
  const limit = Math.max(1, Math.floor(maxEntries) || 1);
  const history: string[] = [];

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'user') continue;

    const entry = normalizeTuiHistoryEntry(message.content);
    if (!entry) continue;

    history.push(entry);
    if (history.length >= limit) break;
  }

  return history;
}

export function dropLatestTuiReadlineHistoryEntry(
  history: string[],
  entry: string,
): void {
  if (history[0] !== entry) return;
  history.shift();
}
