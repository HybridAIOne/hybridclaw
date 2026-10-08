/**
 * `agent adopt` asks the running gateway to move one agent's user data to
 * another, as `agent reset` asks it to reset: the gateway owns the sessions
 * and workers. A failed request is never replayed offline. Prints one JSON
 * line for scripts.
 */
import readline from 'node:readline/promises';
import { gatewayAdoptAgent } from '../gateway/gateway-client.js';

const USAGE =
  'Usage: hybridclaw agent adopt <agent-id> [--from <agent-id>] [--session <old>=<new>]... [--yes]';

export async function handleAgentAdoptCommand(args: string[]): Promise<void> {
  let to = '';
  let from: string | undefined;
  let yes = false;
  const sessions: Array<{ from: string; to: string }> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--yes') {
      yes = true;
    } else if (arg === '--from' && args[index + 1] && !from) {
      from = args[++index];
    } else if (arg === '--session' && args[index + 1]) {
      const [old, next, ...rest] = args[++index].split('=');
      if (!old || !next || rest.length > 0) throw new Error(USAGE);
      sessions.push({ from: old, to: next });
    } else if (!arg.startsWith('-') && !to) {
      to = arg;
    } else {
      throw new Error(USAGE);
    }
  }
  if (!to) throw new Error(USAGE);
  if (!yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('Adopt requires an interactive terminal or --yes.');
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(
        `Move the conversations, tasks and memory of "${from ?? 'main'}" to "${to}" and copy its files over "${to}"'s? [y/N]: `,
      );
      if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
        throw new Error('Agent adopt cancelled.');
    } finally {
      prompt.close();
    }
  }
  console.log(JSON.stringify(await gatewayAdoptAgent({ to, from, sessions })));
}
