const WORKSPACE_CONTEXT_FILE_NAMES = new Set([
  'AGENTS.md',
  'SOUL.md',
  'IDENTITY.md',
  'USER.md',
  'TOOLS.md',
  'MEMORY.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
  'OPENING.md',
  'BOOT.md',
]);

function parseIntegerFlag(label, value, min, max) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function pushUnique(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

export function formatEvalUsage() {
  return [
    'Usage:',
    '/eval mmlu [--n 30] [--subject high_school_computer_science] [--model <model>]',
    '           [--system-prompt full|minimal|none] [--no-soul]',
    '/eval runs [benchmark] [--limit 10]',
  ].join('\n');
}

export function parseEvalArgs(argv, config) {
  const args = argv
    .map((arg) => String(arg || '').trim())
    .filter((arg) => arg.length > 0);
  if (args.length === 0) {
    return {
      kind: 'help',
    };
  }

  if (args[0] === 'runs') {
    let benchmark = null;
    let limit = 10;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === '--limit') {
        index += 1;
        limit = parseIntegerFlag('--limit', args[index], 1, 100);
        continue;
      }
      if (arg.startsWith('--')) {
        throw new Error(`Unknown option: ${arg}`);
      }
      if (benchmark) {
        throw new Error(`Unexpected extra argument: ${arg}`);
      }
      benchmark = arg.toLowerCase();
    }
    return {
      kind: 'runs',
      benchmark,
      limit,
    };
  }

  const benchmark = args[0].toLowerCase();
  if (benchmark !== 'mmlu') {
    throw new Error(`Unsupported eval benchmark: ${benchmark}`);
  }

  const parsed = {
    kind: 'run',
    benchmark,
    n: config.defaultSamples,
    seed: 0,
    subject: null,
    model: null,
    promptMode: 'full',
    omitWorkspaceFiles: [],
  };

  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--n') {
      index += 1;
      parsed.n = parseIntegerFlag('--n', args[index], 1, config.maxSamples);
      continue;
    }
    if (arg === '--seed') {
      index += 1;
      parsed.seed = parseIntegerFlag('--seed', args[index], 0, 2_147_483_647);
      continue;
    }
    if (arg === '--subject') {
      index += 1;
      parsed.subject =
        String(args[index] || '')
          .trim()
          .toLowerCase() || null;
      if (!parsed.subject) {
        throw new Error('Missing value for --subject');
      }
      continue;
    }
    if (arg === '--model') {
      index += 1;
      parsed.model = String(args[index] || '').trim() || null;
      if (!parsed.model) {
        throw new Error('Missing value for --model');
      }
      continue;
    }
    if (arg === '--system-prompt') {
      index += 1;
      const value = String(args[index] || '')
        .trim()
        .toLowerCase();
      if (value !== 'full' && value !== 'minimal' && value !== 'none') {
        throw new Error(
          `Invalid --system-prompt value: ${String(args[index] || '')}`,
        );
      }
      parsed.promptMode = value;
      continue;
    }
    if (arg === '--no-soul') {
      pushUnique(parsed.omitWorkspaceFiles, 'SOUL.md');
      continue;
    }
    if (arg === '--omit-workspace-file') {
      index += 1;
      const value = String(args[index] || '').trim();
      if (!WORKSPACE_CONTEXT_FILE_NAMES.has(value)) {
        throw new Error(`Unknown workspace context file: ${value}`);
      }
      pushUnique(parsed.omitWorkspaceFiles, value);
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  return parsed;
}
