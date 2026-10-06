/**
 * Agent reset runs in the gateway that owns worker interruption. Confirmation
 * is explicit; a failed request is never replayed as an offline deletion.
 */
import readline from 'node:readline/promises';
import { saveAgentDefaults } from '../agents/agent-reset.js';
import { gatewayResetAgent } from '../gateway/gateway-client.js';

export async function handleAgentResetCommand(args: string[]): Promise<void> {
  if (args[0] === 'defaults') {
    if (args.length !== 2)
      throw new Error('Usage: hybridclaw agent defaults <json>');
    console.log(`Saved reset defaults for ${saveAgentDefaults(args[1])}.`);
    return;
  }
  const [, id, ...flags] = args;
  if (
    !id ||
    flags.some((flag) => flag !== '--yes' && flag !== '--keep-history')
  ) {
    throw new Error(
      'Usage: hybridclaw agent reset <agent-id> [--yes] [--keep-history]',
    );
  }
  const deleteHistory = !flags.includes('--keep-history');
  if (!flags.includes('--yes')) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
      throw new Error('Reset requires an interactive terminal or --yes.');
    const prompt = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = await prompt.question(
        `Reset "${id}"? This deletes its files and settings${deleteHistory ? ', conversations and scheduled tasks' : ''}. [y/N]: `,
      );
      if (!['y', 'yes'].includes(answer.trim().toLowerCase()))
        throw new Error('Agent reset cancelled.');
    } finally {
      prompt.close();
    }
  }
  const result = await gatewayResetAgent(id, deleteHistory);
  console.log(`Reset agent ${result.agentId} to its provisioned defaults.`);
}
