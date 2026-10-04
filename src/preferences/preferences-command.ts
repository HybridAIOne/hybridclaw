/**
 * Companion transport for the runtime preference record. Base64url JSON keeps
 * text intact through chat relays; acknowledgements clear only accepted events.
 * User identity comes from the authenticated command, never the payload.
 */
import {
  badCommand,
  plainCommand,
} from '../gateway/gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from '../gateway/gateway-types.js';
import { chatSafeJson } from '../gateway/schedule-command.js';
import {
  mergePreferences,
  PreferenceError,
  readPreferences,
} from './preferences.js';

export function handlePreferencesCommand(
  req: GatewayCommandRequest,
): GatewayCommandResult {
  const [action, token, ...extra] = req.args
    .slice(1)
    .filter((arg) => arg !== '--json');
  try {
    if (!req.userId)
      throw new PreferenceError('No verified user for preferences.');
    if (action === 'show' && !token)
      return plainCommand(
        chatSafeJson({ version: 1, events: readPreferences(req.userId) }),
      );
    if (
      action !== 'sync' ||
      !token ||
      extra.length ||
      token.length > 400_000 ||
      !/^[A-Za-z0-9_-]+$/.test(token)
    )
      throw new PreferenceError(
        'Use /preferences sync <base64url JSON events> --json or /preferences show --json.',
      );
    let events: unknown;
    try {
      events = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    } catch {
      throw new PreferenceError('Invalid preference JSON.');
    }
    return plainCommand(
      chatSafeJson({
        version: 1,
        acknowledged: mergePreferences(req.userId, events),
      }),
    );
  } catch (error) {
    if (!(error instanceof PreferenceError)) throw error;
    return badCommand('Preferences', error.message);
  }
}
