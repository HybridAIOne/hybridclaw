export interface ParsedTuiSlashCommand {
  cmd: string;
  parts: string[];
}

export function parseTuiSlashCommand(input: string): ParsedTuiSlashCommand {
  const raw = input.startsWith('/') ? input.slice(1).trim() : input.trim();
  if (!raw) return { cmd: '', parts: [] };

  const tokens = raw.split(/\s+/).filter(Boolean);
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
