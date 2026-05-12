import { normalizeArgs } from '../cli/common.js';
import { runPolicyCommand } from '../commands/policy-command.js';

// biome-ignore lint/suspicious/useAwait: callers rely on Promise rejection semantics for thrown errors.
export async function handlePolicyCommand(args: string[]): Promise<void> {
  const result = runPolicyCommand(normalizeArgs(args), {
    workspacePath: process.cwd(),
  });
  if (result.kind === 'error') {
    throw new Error(result.text);
  }
  console.log(result.text);
}
