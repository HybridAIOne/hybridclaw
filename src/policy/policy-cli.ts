import { normalizeArgs } from '../cli/common.js';
import { runPolicyCommand } from '../commands/policy-command.js';

export async function handlePolicyCommand(args: string[]): Promise<void> {
  const result = runPolicyCommand(normalizeArgs(args), {
    workspacePath: process.cwd(),
  });
  if (result.kind === 'error') {
    throw new Error(result.text);
  }
  console.log(result.text);
}
