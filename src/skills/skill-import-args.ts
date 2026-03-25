export interface ParsedSkillImportArgs {
  source: string;
  force: boolean;
  skipSkillScan: boolean;
}

export interface SkillImportArgsParserOptions {
  commandPrefix: string;
  commandName: 'import' | 'sync';
  allowForce?: boolean;
}

export function parseSkillImportArgs(
  args: readonly unknown[],
  options: SkillImportArgsParserOptions,
): ParsedSkillImportArgs {
  const allowForce = options.allowForce ?? true;
  const usage = allowForce
    ? `${options.commandPrefix} ${options.commandName} [--force] [--skip-skill-scan] <source>`
    : `${options.commandPrefix} ${options.commandName} [--skip-skill-scan] <source>`;
  let source: string | null = null;
  let force = false;
  let skipSkillScan = false;

  for (const arg of args) {
    const normalized = String(arg ?? '').trim();
    if (!normalized) continue;
    if (normalized === '--force') {
      if (!allowForce) {
        throw new Error(
          `Unknown option for \`${options.commandPrefix} ${options.commandName}\`: ${normalized}. Use \`${usage}\`.`,
        );
      }
      force = true;
      continue;
    }
    if (normalized === '--skip-skill-scan') {
      skipSkillScan = true;
      continue;
    }
    if (normalized.startsWith('--')) {
      throw new Error(
        `Unknown option for \`${options.commandPrefix} ${options.commandName}\`: ${normalized}. Use \`${usage}\`.`,
      );
    }
    if (source === null) {
      source = normalized;
      continue;
    }
    throw new Error(`Unexpected extra arguments for \`${usage}\`.`);
  }

  if (!source) {
    throw new Error(`Missing source for \`${usage}\`.`);
  }

  return { source, force, skipSkillScan };
}
