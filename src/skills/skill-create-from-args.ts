export type ParsedSkillCreateFromArgs =
  | {
      ok: true;
      action: 'stage';
      sourceDescription: string;
      suggestedName?: string;
      category?: string;
    }
  | {
      ok: true;
      action: 'apply' | 'reject';
      proposalId: string;
    }
  | { ok: false; message: string };

export function parseSkillCreateFromArgs(
  args: readonly string[],
  options: { usageCommand?: string } = {},
): ParsedSkillCreateFromArgs {
  let suggestedName: string | undefined;
  let category: string | undefined;
  let action: 'apply' | 'reject' | null = null;
  let proposalId = '';
  const sourceParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index] || '');
    const arg = raw.trim();
    const lowered = arg.toLowerCase();

    if (lowered === '--apply' || lowered === 'apply') {
      if (action) {
        return {
          ok: false,
          message: 'Choose only one action: `--apply` or `--reject`.',
        };
      }
      const next = String(args[index + 1] || '').trim();
      if (!next) {
        return { ok: false, message: 'Missing proposal id for `--apply`.' };
      }
      action = 'apply';
      proposalId = next;
      index += 1;
      continue;
    }

    if (lowered.startsWith('--apply=')) {
      if (action) {
        return {
          ok: false,
          message: 'Choose only one action: `--apply` or `--reject`.',
        };
      }
      action = 'apply';
      proposalId = arg.slice('--apply='.length).trim();
      if (!proposalId) {
        return { ok: false, message: 'Missing proposal id for `--apply`.' };
      }
      continue;
    }

    if (lowered === '--reject' || lowered === 'reject') {
      if (action) {
        return {
          ok: false,
          message: 'Choose only one action: `--apply` or `--reject`.',
        };
      }
      const next = String(args[index + 1] || '').trim();
      if (!next) {
        return { ok: false, message: 'Missing proposal id for `--reject`.' };
      }
      action = 'reject';
      proposalId = next;
      index += 1;
      continue;
    }

    if (lowered.startsWith('--reject=')) {
      if (action) {
        return {
          ok: false,
          message: 'Choose only one action: `--apply` or `--reject`.',
        };
      }
      action = 'reject';
      proposalId = arg.slice('--reject='.length).trim();
      if (!proposalId) {
        return { ok: false, message: 'Missing proposal id for `--reject`.' };
      }
      continue;
    }

    if (lowered === '--name') {
      const next = String(args[index + 1] || '').trim();
      if (!next) return { ok: false, message: 'Missing value for `--name`.' };
      suggestedName = next;
      index += 1;
      continue;
    }
    if (lowered.startsWith('--name=')) {
      suggestedName = arg.slice('--name='.length).trim();
      if (!suggestedName) {
        return { ok: false, message: 'Missing value for `--name`.' };
      }
      continue;
    }

    if (lowered === '--category') {
      const next = String(args[index + 1] || '').trim();
      if (!next) {
        return { ok: false, message: 'Missing value for `--category`.' };
      }
      category = next;
      index += 1;
      continue;
    }
    if (lowered.startsWith('--category=')) {
      category = arg.slice('--category='.length).trim();
      if (!category) {
        return { ok: false, message: 'Missing value for `--category`.' };
      }
      continue;
    }

    if (arg.startsWith('-')) {
      return { ok: false, message: `Unknown flag: ${arg}` };
    }
    sourceParts.push(raw);
  }

  if (action) {
    if (sourceParts.length > 0 || suggestedName || category) {
      return {
        ok: false,
        message:
          '`--apply` and `--reject` only accept a proposal id, not source material.',
      };
    }
    return { ok: true, action, proposalId };
  }

  const sourceDescription = sourceParts.join(' ').trim();
  if (!sourceDescription) {
    const usageCommand = options.usageCommand || 'skill create-from';
    return {
      ok: false,
      message: `Usage: \`${usageCommand} [--name <name>] [--category <category>] <source>\`.`,
    };
  }
  return {
    ok: true,
    action: 'stage',
    sourceDescription,
    suggestedName,
    category,
  };
}
