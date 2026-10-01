/**
 * `/name` — what the agent calls the user, kept as "What to call them" in the
 * agent's USER.md (`workspace.ts`), which is in every turn's prompt. Companion
 * apps edit it from their settings with `--json`, answered in one line that
 * survives a chat relay (`chatSafeJson`). The answer also names USER.md's
 * "Name", which the agent goes by while "What to call them" is empty.
 */
import {
  MAX_USER_NAME_LENGTH,
  readUserNames,
  writeUserPreferredName,
} from '../workspace.js';
import { badCommand, plainCommand } from './gateway-command-results.js';
import type {
  GatewayCommandRequest,
  GatewayCommandResult,
} from './gateway-types.js';
import { chatSafeJson } from './schedule-command.js';

const USAGE =
  'Usage: `/name` shows what the agent calls you, `/name set <name>` changes it, `/name clear` removes it. Add `--json` for a machine-readable answer.';

// Without a name to call them, the agent goes by their full name.
function answer(agentId: string, json: boolean): GatewayCommandResult {
  const { name, fullName } = readUserNames(agentId);
  if (json) {
    return plainCommand(
      chatSafeJson({ version: 1, name, full_name: fullName }),
    );
  }
  const called = name ?? fullName;
  return plainCommand(
    called
      ? `The agent calls you ${called}.`
      : 'No name yet. Set one with `/name set <name>`.',
  );
}

export function handleNameCommand(
  req: GatewayCommandRequest,
  agentId: string,
): GatewayCommandResult {
  const rest = req.args.slice(1).map(String);
  const json = rest.includes('--json');
  const [sub = 'show', ...operands] = rest.filter((arg) => arg !== '--json');
  const action = sub.toLowerCase();
  if (action === 'show' && operands.length === 0) return answer(agentId, json);
  if (action === 'clear' && operands.length === 0) {
    writeUserPreferredName(agentId, null);
    return answer(agentId, json);
  }
  if (action === 'set') {
    const name = operands.join(' ').trim();
    if (!name) return badCommand('Usage', USAGE);
    if ([...name].length > MAX_USER_NAME_LENGTH) {
      return badCommand(
        'Name',
        `A name has at most ${MAX_USER_NAME_LENGTH} characters.`,
      );
    }
    writeUserPreferredName(agentId, name);
    return answer(agentId, json);
  }
  return badCommand('Usage', USAGE);
}
