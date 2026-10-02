/**
 * `/timezone` — the user's time zone, kept as "Timezone" in the agent's
 * USER.md (`workspace.ts`). Schedules the agent creates without a zone of
 * their own, the daily note and the prompt's current time use it, and the
 * host's zone while there is no valid one. Companion apps send the phone's
 * zone with `--json`, answered in one line that survives a chat relay
 * (`chatSafeJson`).
 */
import {
  isValidTimezone,
  resolveEffectiveTimezone,
} from '../../container/shared/workspace-time.js';
import { readUserTimezone, writeUserTimezone } from '../workspace.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

const USAGE =
  'Usage: `/timezone` shows your time zone, `/timezone set <zone>` changes it, `/timezone clear` removes it. Add `--json` for a machine-readable answer.';

// IANA names only, such as `Europe/Berlin`, `America/Port-au-Prince` or
// `Etc/GMT+1`; not the UTC offsets `Intl` also takes.
const ZONE_NAME = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/;

// The zone in its canonical spelling, so `europe/berlin` is kept as
// `Europe/Berlin`. Null for anything that isn't one.
function zoneName(text: string): string | null {
  if (!ZONE_NAME.test(text) || !isValidTimezone(text)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: text }).resolvedOptions()
    .timeZone;
}

function answer(agentId: string, json: boolean): GatewayCommandResult {
  const written = readUserTimezone(agentId);
  const zone = written && isValidTimezone(written) ? written : null;
  if (json) return plainCommand(chatSafeJson({ version: 1, timezone: zone }));
  if (zone) return plainCommand(`Your time zone is ${zone}.`);
  const fallback = resolveEffectiveTimezone();
  return plainCommand(
    written
      ? `USER.md says "${written}", which isn't a time zone, so the agent uses ${fallback}. Set one with \`/timezone set <zone>\`.`
      : `No time zone yet, so the agent uses ${fallback}. Set one with \`/timezone set <zone>\`.`,
  );
}

export function handleTimezoneCommand(
  req: GatewayCommandRequest,
  agentId: string,
): GatewayCommandResult {
  const rest = req.args.slice(1).map(String);
  const json = rest.includes('--json');
  const [sub = 'show', ...operands] = rest.filter((arg) => arg !== '--json');
  const action = sub.toLowerCase();
  if (action === 'show' && operands.length === 0) return answer(agentId, json);
  if (action === 'clear' && operands.length === 0) {
    writeUserTimezone(agentId, null);
    return answer(agentId, json);
  }
  if (action === 'set') {
    if (operands.length !== 1) return badCommand('Usage', USAGE);
    const zone = zoneName(operands[0]);
    if (!zone) {
      return badCommand(
        'Time zone',
        `"${operands[0]}" isn't a time zone. Use an IANA name such as Europe/Berlin or America/New_York.`,
      );
    }
    writeUserTimezone(agentId, zone);
    return answer(agentId, json);
  }
  return badCommand('Usage', USAGE);
}
