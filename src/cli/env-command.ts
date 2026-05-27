import {
  listStoredRuntimeEnvNames,
  readStoredRuntimeEnv,
  readStoredRuntimeEnvValue,
  runtimeEnvPath,
  saveNamedRuntimeEnv,
  validateRuntimeEnvName,
} from '../config/runtime-env.js';
import { normalizeArgs } from './common.js';
import { isHelpRequest, printEnvUsage } from './help.js';

function formatEnvEntries(values: Record<string, string>): string[] {
  const names = Object.keys(values).sort((left, right) =>
    left.localeCompare(right),
  );
  return names.length > 0
    ? names.map((name) => `${name}=${values[name]}`)
    : ['(none)'];
}

export async function handleEnvCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printEnvUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();

  if (sub === 'list') {
    console.log(`Runtime env store: ${runtimeEnvPath()}`);
    for (const line of formatEnvEntries(readStoredRuntimeEnv())) {
      console.log(line);
    }
    return;
  }

  if (sub === 'set') {
    const name = validateRuntimeEnvName(normalized[1] || '');
    const value = normalized.slice(2).join(' ').trim();
    if (!value) {
      printEnvUsage();
      throw new Error('Usage: `hybridclaw env set <name> <value>`');
    }
    saveNamedRuntimeEnv({ [name]: value });
    console.log(`Stored runtime env \`${name}\` in \`${runtimeEnvPath()}\`.`);
    return;
  }

  if (sub === 'unset' || sub === 'delete' || sub === 'remove') {
    const name = validateRuntimeEnvName(normalized[1] || '');
    saveNamedRuntimeEnv({ [name]: null });
    console.log(`Removed runtime env \`${name}\`.`);
    return;
  }

  if (sub === 'show' || sub === 'get') {
    const name = validateRuntimeEnvName(normalized[1] || '');
    const value = readStoredRuntimeEnvValue(name);
    console.log(`Name: ${name}`);
    console.log(`Stored: ${value ? 'yes' : 'no'}`);
    console.log(`Value: ${value || '(unset)'}`);
    console.log(`Path: ${runtimeEnvPath()}`);
    return;
  }

  if (sub === 'names') {
    const names = listStoredRuntimeEnvNames();
    console.log(names.length > 0 ? names.join(', ') : '(none)');
    return;
  }

  throw new Error(
    'Unknown env subcommand. Use `hybridclaw env list|set|show|unset`.',
  );
}
