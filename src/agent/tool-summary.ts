import { BUILTIN_TOOLS } from '#shared/builtin-tools.js';

export interface ToolGroup {
  label: string;
  tools: string[];
}

export interface ToolSummaryOptions {
  allowedTools?: readonly string[] | null;
  blockedTools?: readonly string[] | null;
}

const TOOL_GROUPS: ToolGroup[] = [];
for (const tool of BUILTIN_TOOLS) {
  const group = TOOL_GROUPS.find((entry) => entry.label === tool.group);
  if (group) group.tools.push(tool.name);
  else TOOL_GROUPS.push({ label: tool.group, tools: [tool.name] });
}

const KNOWN_TOOL_NAMES = new Set(BUILTIN_TOOLS.map((tool) => tool.name));

function normalizeToolList(
  tools: readonly string[] | null | undefined,
): string[] {
  if (!Array.isArray(tools)) return [];
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const entry of tools) {
    const name = String(entry || '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

function formatToolList(tools: readonly string[]): string {
  return tools.map((tool) => `\`${tool}\``).join(', ');
}

export function getKnownToolGroups(): ToolGroup[] {
  return TOOL_GROUPS.map((group) => ({
    label: group.label,
    tools: [...group.tools],
  }));
}

export function listKnownToolNames(): string[] {
  return [...KNOWN_TOOL_NAMES].sort((left, right) => left.localeCompare(right));
}

export function isKnownToolName(name: string): boolean {
  return KNOWN_TOOL_NAMES.has(String(name || '').trim());
}

export function buildToolsSummary(options: ToolSummaryOptions = {}): string {
  const allowedTools = normalizeToolList(options.allowedTools);
  const blockedTools = new Set(normalizeToolList(options.blockedTools));
  const available =
    allowedTools.length > 0
      ? new Set(allowedTools)
      : new Set(Array.from(KNOWN_TOOL_NAMES));

  for (const blocked of blockedTools) {
    available.delete(blocked);
  }

  const lines = ['## Your Tools'];
  for (const group of TOOL_GROUPS) {
    const present = group.tools.filter((tool) => available.has(tool));
    if (present.length === 0) continue;
    lines.push(`**${group.label}**: ${formatToolList(present)}`);
  }

  const mcpTools = Array.from(available).filter((tool) => tool.includes('__'));
  if (mcpTools.length > 0) {
    mcpTools.sort((a, b) => a.localeCompare(b));
    lines.push(`**MCP**: ${formatToolList(mcpTools)}`);
  }

  const otherTools = Array.from(available).filter(
    (tool) => !KNOWN_TOOL_NAMES.has(tool) && !tool.includes('__'),
  );
  if (otherTools.length > 0) {
    otherTools.sort((a, b) => a.localeCompare(b));
    lines.push(`**Other**: ${formatToolList(otherTools)}`);
  }

  return lines.length > 1 ? lines.join('\n') : '';
}
