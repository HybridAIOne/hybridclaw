/**
 * Who may run a restricted gateway command: a local operator session (TUI,
 * CLI, or the web console, outside any guild) whose credentials claim the
 * required admin action. Plugin config edits need `admin.config.write`; a
 * plugin command declaring `adminAction` needs that action, and channel users
 * are refused before its handler runs.
 *
 * NOT admin HTTP route auth (`security/admin-rbac.ts` owns the action set);
 * this only gates commands that arrive through the command dispatcher.
 */
import type { PluginCommandDefinition } from '../plugins/plugin-types.js';
import {
  type AdminRbacAction,
  isAdminActionClaimed,
} from '../security/admin-rbac.js';
import { badCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';

export function isLocalSession(
  req: GatewayCommandRequest,
  action: AdminRbacAction = 'admin.config.write',
): boolean {
  return (
    req.guildId === null &&
    (req.channelId === 'web' ||
      req.channelId === 'tui' ||
      req.channelId === 'cli') &&
    isAdminActionClaimed(req.adminActions, action)
  );
}

export function refuseRestrictedPluginCommand(
  command: string,
  definition: Pick<PluginCommandDefinition, 'adminAction'>,
  req: GatewayCommandRequest,
): GatewayCommandResult | null {
  if (!definition.adminAction || isLocalSession(req, definition.adminAction)) {
    return null;
  }
  return badCommand(
    'Command Restricted',
    `\`${command}\` is only available from local TUI/web sessions.`,
  );
}
