import type {
  BoardCardActor,
  BoardCardColumn,
  BoardCardEdgeKind,
  BoardCardSource,
} from '../board/card-store.js';
import { isHelpRequest, printBoardUsage } from './help.js';

interface ParsedBoardArgs {
  positional: string[];
  flags: Map<string, string>;
  json: boolean;
}

function parseBoardArgs(args: string[]): ParsedBoardArgs {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const equalsIndex = arg.indexOf('=');
    if (equalsIndex > 0) {
      const name = arg.slice(2, equalsIndex);
      const value = arg.slice(equalsIndex + 1).trim();
      if (!value) throw new Error(`Missing value for \`--${name}\`.`);
      flags.set(name, value);
      continue;
    }
    const name = arg.slice(2);
    const value = String(args[index + 1] || '').trim();
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for \`--${name}\`.`);
    }
    flags.set(name, value);
    index += 1;
  }

  return { positional, flags, json };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name)?.trim();
  if (!value) throw new Error(`Missing \`--${name}\`.`);
  return value;
}

function optionalFlag(flags: Map<string, string>, name: string): string | null {
  return flags.get(name)?.trim() || null;
}

function parseColumn(value: string | null): BoardCardColumn | undefined {
  if (!value) return undefined;
  if (
    value === 'triage' ||
    value === 'todo' ||
    value === 'in_progress' ||
    value === 'in_review' ||
    value === 'done'
  ) {
    return value;
  }
  throw new Error(`Invalid board card column: ${value}`);
}

function parseEdgeKind(value: string): BoardCardEdgeKind {
  if (value === 'blocks' || value === 'blocked_by' || value === 'related') {
    return value;
  }
  throw new Error(`Invalid board edge kind: ${value}`);
}

function parseRevisionId(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error('Revision id must be an integer.');
  const revisionId = Number.parseInt(value, 10);
  if (revisionId < 1) throw new Error('Revision id must be positive.');
  return revisionId;
}

function parseActor(flags: Map<string, string>): BoardCardActor {
  const userId = optionalFlag(flags, 'user');
  const agentId = optionalFlag(flags, 'agent');
  const system = optionalFlag(flags, 'system');
  const count = [userId, agentId, system].filter(Boolean).length;
  if (count > 1) {
    throw new Error('Use only one actor flag: --user, --agent, or --system.');
  }
  if (userId) return { userId };
  if (agentId) return { agentId };
  return { system: system || 'cli' };
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) console.log(JSON.stringify(entry));
    return;
  }
  console.log(JSON.stringify(value));
}

async function handleCardCommand(args: string[]): Promise<void> {
  const sub = (args[0] || '').trim().toLowerCase();
  const parsed = parseBoardArgs(args.slice(1));
  const board = await import('../board/card-store.js');

  if (sub === 'create') {
    const card = board.createCard(
      {
        id: optionalFlag(parsed.flags, 'id') || undefined,
        title: requireFlag(parsed.flags, 'title'),
        body: optionalFlag(parsed.flags, 'body') || undefined,
        owner:
          optionalFlag(parsed.flags, 'agent') != null
            ? { agentId: requireFlag(parsed.flags, 'agent') }
            : { userId: optionalFlag(parsed.flags, 'user') || 'cli' },
        column: parseColumn(optionalFlag(parsed.flags, 'column')),
        status: optionalFlag(parsed.flags, 'status') || undefined,
        source:
          (optionalFlag(parsed.flags, 'source') as BoardCardSource | null) ||
          undefined,
        parent: optionalFlag(parsed.flags, 'parent'),
      },
      { actor: parseActor(parsed.flags) },
    );
    printResult({ card }, parsed.json);
    return;
  }

  if (sub === 'list') {
    printResult({ cards: board.listCards() }, parsed.json);
    return;
  }

  if (sub === 'update') {
    const id = parsed.positional[0] || requireFlag(parsed.flags, 'id');
    const patch = {
      ...(optionalFlag(parsed.flags, 'title')
        ? { title: requireFlag(parsed.flags, 'title') }
        : {}),
      ...(optionalFlag(parsed.flags, 'body') != null
        ? { body: requireFlag(parsed.flags, 'body') }
        : {}),
      ...(parseColumn(optionalFlag(parsed.flags, 'column'))
        ? { column: parseColumn(optionalFlag(parsed.flags, 'column')) }
        : {}),
      ...(optionalFlag(parsed.flags, 'status')
        ? { status: requireFlag(parsed.flags, 'status') }
        : {}),
    };
    printResult(
      {
        card: board.updateCard(id, patch, { actor: parseActor(parsed.flags) }),
      },
      parsed.json,
    );
    return;
  }

  printBoardUsage();
  process.exitCode = 1;
}

async function handleEdgeCommand(args: string[]): Promise<void> {
  const sub = (args[0] || '').trim().toLowerCase();
  const parsed = parseBoardArgs(args.slice(1));
  const board = await import('../board/card-store.js');

  if (sub === 'add') {
    const edge = board.addEdge(
      requireFlag(parsed.flags, 'from'),
      requireFlag(parsed.flags, 'to'),
      parseEdgeKind(requireFlag(parsed.flags, 'kind')),
      { actor: parseActor(parsed.flags) },
    );
    printResult({ edge }, parsed.json);
    return;
  }

  if (sub === 'list') {
    const kind = optionalFlag(parsed.flags, 'kind');
    printResult(
      {
        edges: board.listEdges(
          requireFlag(parsed.flags, 'card'),
          kind ? parseEdgeKind(kind) : undefined,
        ),
      },
      parsed.json,
    );
    return;
  }

  if (sub === 'delete' || sub === 'remove') {
    printResult(
      {
        edge: board.removeEdge(requireFlag(parsed.flags, 'id'), {
          actor: parseActor(parsed.flags),
        }),
      },
      parsed.json,
    );
    return;
  }

  if (sub === 'revisions') {
    printResult(
      { revisions: board.listEdgeRevisions(requireFlag(parsed.flags, 'id')) },
      parsed.json,
    );
    return;
  }

  if (sub === 'restore') {
    printResult(
      {
        edge: board.restoreEdgeRevision(
          requireFlag(parsed.flags, 'id'),
          parseRevisionId(requireFlag(parsed.flags, 'revision')),
          { actor: parseActor(parsed.flags) },
        ),
      },
      parsed.json,
    );
    return;
  }

  printBoardUsage();
  process.exitCode = 1;
}

export async function handleBoardCommand(args: string[]): Promise<void> {
  if (args.length === 0 || isHelpRequest(args)) {
    printBoardUsage();
    return;
  }

  const sub = (args[0] || '').trim().toLowerCase();
  if (sub === 'card' || sub === 'cards') {
    await handleCardCommand(args.slice(1));
    return;
  }
  if (sub === 'edge' || sub === 'edges') {
    await handleEdgeCommand(args.slice(1));
    return;
  }
  if (sub === 'blocked') {
    const parsed = parseBoardArgs(args.slice(1));
    const board = await import('../board/card-store.js');
    const cardId = requireFlag(parsed.flags, 'card');
    printResult({ cardId, blocked: board.isBlocked(cardId) }, parsed.json);
    return;
  }

  printBoardUsage();
  process.exitCode = 1;
}
