import type { GatewayHistoryMessage } from './gateway/gateway-types.js';

const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

function normalizeTuiHistoryEntry(content: string): string | null {
  const normalized = String(content || '')
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!normalized) return null;
  if (normalized.includes('\n')) return null;
  return normalized;
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
