/**
 * Gateway command-result builders — the one shape every slash-command handler
 * returns (`error` / `info` / `plain` GatewayCommandResult).
 *
 * Pure constructors only; rendering per channel lives in `renderGatewayCommand`.
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
