export interface ParsedTuiSlashCommand {
  cmd: string;
  parts: string[];
}

function tokenizeTuiSlashInput(raw: string): string[] {
  return raw.match(/"[^"]*"|\S+/g) ?? [];
}

export function parseTuiSlashCommand(input: string): ParsedTuiSlashCommand {
  const raw = input.startsWith('/') ? input.slice(1).trim() : input.trim();
  if (!raw) return { cmd: '', parts: [] };

  const tokens = tokenizeTuiSlashInput(raw);
  const cmd = (tokens[0] || '').toLowerCase();
  if (!cmd) return { cmd: '', parts: [] };

  if (cmd !== 'mcp') {
    return { cmd, parts: tokens };
  }

  const sub = (tokens[1] || '').toLowerCase();
  if (sub !== 'add') {
    return { cmd, parts: tokens };
  }

  const addMatch = raw.match(/^mcp\s+add\s+(\S+)\s+([\s\S]+)$/i);
  if (!addMatch) {
    return { cmd, parts: tokens };
  }

  const [, name, jsonPayload] = addMatch;
  return {
    cmd,
    parts: ['mcp', 'add', name, jsonPayload.trim()],
  };
}

export function mapTuiSlashCommandToGatewayArgs(
  parts: string[],
): string[] | null {
  const cmd = (parts[0] || '').trim().toLowerCase();
  if (!cmd) return null;

  switch (cmd) {
    case 'bots':
      return ['bot', 'list'];

    case 'bot': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'info') return ['bot', 'info'];
      if (sub === 'list') return ['bot', 'list'];
      if (sub === 'set') return ['bot', 'set', ...parts.slice(2)];
      return ['bot', 'set', ...parts.slice(1)];
    }

    case 'model': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (sub === 'info' || sub === 'list') return ['model', sub];
      if (sub === 'default') {
        return parts.length > 2
          ? ['model', 'default', ...parts.slice(2)]
          : ['model', 'default'];
      }
      if (sub === 'set') return ['model', 'set', ...parts.slice(2)];
      if (parts.length > 1) return ['model', 'set', ...parts.slice(1)];
      return null;
    }

    case 'agent': {
      const sub = (parts[1] || '').trim().toLowerCase();
      if (!sub || sub === 'info') return ['agent'];
      if (sub === 'list') return ['agent', 'list'];
      if (sub === 'switch') return ['agent', 'switch', ...parts.slice(2)];
      if (sub === 'create') {
        const agentId = (parts[2] || '').trim();
        if (!agentId) return ['agent', 'create'];
        if ((parts[3] || '').trim().toLowerCase() === '--model') {
          return ['agent', 'create', agentId, ...parts.slice(3)];
        }
        if (parts.length === 4) {
          return ['agent', 'create', agentId, '--model', parts[3]];
        }
        return ['agent', 'create', ...parts.slice(2)];
      }
      return ['agent', ...parts.slice(1)];
    }

    case 'status':
      return ['status'];

    case 'channel-mode':
      return ['channel', 'mode', ...parts.slice(1)];

    case 'channel-policy':
      return ['channel', 'policy', ...parts.slice(1)];

    case 'rag':
      return parts.length > 1 ? ['rag', parts[1]] : ['rag'];

    case 'ralph':
      return parts.length > 1
        ? ['ralph', ...parts.slice(1)]
        : ['ralph', 'info'];

    case 'mcp':
      return parts.length > 1 ? ['mcp', ...parts.slice(1)] : ['mcp', 'list'];

    case 'fullauto':
      return parts.length > 1
        ? ['fullauto', ...parts.slice(1)]
        : ['fullauto'];

    case 'compact':
      return ['compact'];

    case 'clear':
      return ['clear'];

    case 'reset':
      return parts.length > 1 ? ['reset', ...parts.slice(1)] : ['reset'];

    case 'usage':
      return ['usage', ...parts.slice(1)];

    case 'export':
      return ['export', 'session', ...parts.slice(1)];

    case 'sessions':
      return ['sessions'];

    case 'audit':
      return ['audit', ...parts.slice(1)];

    case 'schedule':
      return ['schedule', ...parts.slice(1)];

    case 'stop':
    case 'abort':
      return ['stop'];

    default:
      return null;
  }
}
