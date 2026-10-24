/**
 * Gateway command-result builders — the one shape every slash-command handler
 * returns (`error` / `info` / `plain` GatewayCommandResult).
 *
 * Pure response construction and relay-safe JSON; channel rendering lives in
 * `renderGatewayCommand`. This module never imports command handlers or runners.
 */
import type { GatewayCommandResult } from './gateway-types.js';

export function badCommand(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

export function infoCommand(
  title: string,
  text: string,
  components?: GatewayCommandResult['components'],
  extra?: Partial<GatewayCommandResult>,
): GatewayCommandResult {
  return {
    kind: 'info',
    title,
    text,
    ...(components === undefined ? {} : { components }),
    ...(extra || {}),
  };
}

export function plainCommand(text: string): GatewayCommandResult {
  return { kind: 'plain', text };
}

const STREAM_UNSAFE: Record<string, string> = {
  '\\\\': '\\u005c',
  '\\n': '\\u000a',
  '\\r': '\\u000d',
};

/**
 * One line of JSON that survives a chat relay: relays escape line breaks as
 * the two characters backslash-n and their clients turn every such pair back
 * into a line break, which would corrupt a string holding an escaped one.
 */
export function chatSafeJson(value: unknown): string {
  return JSON.stringify(value).replace(
    /\\[\\nr]/g,
    (pair) => STREAM_UNSAFE[pair] ?? pair,
  );
}
