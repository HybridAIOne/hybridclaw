/** MCP effects keep ordinary policy rules; only configured brokers own marked write grants. */
import type { ClassifiedAction } from '../approval-policy.js';
import { classifyMcpTool } from './tool-classifier.js';
import type { McpToolBehavior } from './types.js';
export function classifyMcpAction(
  toolName: string,
  commandPreview: string,
  behavior: McpToolBehavior | undefined,
): ClassifiedAction {
  const lowerTool = toolName.toLowerCase();
  const kind = behavior?.kind ?? classifyMcpTool(lowerTool);
  const annotations = behavior?.annotations;
  // A server can namespace its own tools (`hybridai__google__send_mail`),
  // so the tool is everything after the first separator.
  const separator = lowerTool.indexOf('__');
  const serverName = lowerTool.slice(0, separator);
  const rawToolName = lowerTool.slice(separator + 2);
  const toolLabel = annotations?.title || rawToolName || lowerTool;
  const actionKey = `mcp:${serverName || 'server'}:${kind}`;

  if (behavior?.platformApproval) {
    return {
      tier: 'green',
      actionKey: `mcp:${serverName}:platform`,
      intent: `run MCP tool ${toolLabel}`,
      consequenceIfDenied: 'Nothing is changed.',
      reason: 'The platform enforces one-shot approval for this change.',
      commandPreview: commandPreview,
      pathHints: [],
      hostHints: [],
      writeIntent: true,
      promotableRed: false,
      stickyYellow: true,
    };
  }

  if (kind === 'read' || kind === 'search' || kind === 'fetch') {
    return {
      tier: 'green',
      actionKey,
      intent: `run MCP tool ${toolLabel}`,
      consequenceIfDenied: 'I will continue without this MCP lookup.',
      reason: annotations?.readOnlyHint
        ? 'the MCP server marks this tool read-only'
        : 'this MCP tool appears read-only',
      commandPreview: commandPreview,
      pathHints: [],
      hostHints: [],
      writeIntent: false,
      promotableRed: false,
      stickyYellow: false,
    };
  }

  if (kind === 'delete' || kind === 'execute') {
    const marked = annotations?.destructiveHint === true;
    return {
      tier: 'red',
      actionKey,
      intent: `run MCP tool ${toolLabel}`,
      consequenceIfDenied: marked
        ? 'I will continue without making that change.'
        : kind === 'delete'
          ? 'I will continue without deleting anything.'
          : 'I will continue without executing that action.',
      reason: marked
        ? 'the MCP server marks this tool destructive'
        : kind === 'delete'
          ? 'this MCP tool appears destructive'
          : 'this MCP tool appears to execute commands or external actions',
      commandPreview: commandPreview,
      pathHints: [],
      hostHints: [],
      writeIntent: true,
      promotableRed: false,
      stickyYellow: false,
    };
  }

  // A write that reaches outside (mail, an invite, a PR comment) asks in
  // the default mode too; full access still runs it. Owner call,
  // 2026-10-02: the Hy app promises to send nothing without approval, and
  // scheduled runs read mail strangers wrote. The key names the tool, so
  // trusting one send does not trust the server's other writes.
  // Owner call, 2026-10-10: subscribed music generation creates a file
  // for the user; contacting its provider is not sending or publishing.
  if (
    annotations?.openWorldHint === true &&
    lowerTool !== 'hybridai__music_generate'
  ) {
    return {
      tier: 'red',
      actionKey: `${actionKey}:${rawToolName}`,
      intent: `run MCP tool ${toolLabel}`,
      consequenceIfDenied:
        'Nothing is sent or changed outside, and I will continue without this step.',
      reason:
        'the MCP server says this tool reaches outside, for example it sends or posts',
      commandPreview: commandPreview,
      pathHints: [],
      hostHints: [],
      writeIntent: true,
      promotableRed: false,
      stickyYellow: true,
    };
  }

  return {
    tier: 'yellow',
    actionKey,
    intent: `run MCP tool ${toolLabel}`,
    consequenceIfDenied: 'I will continue without this MCP action.',
    reason:
      kind === 'edit'
        ? 'this MCP tool appears to modify state'
        : 'this MCP tool may have side effects',
    commandPreview: commandPreview,
    pathHints: [],
    hostHints: [],
    writeIntent: kind === 'edit',
    promotableRed: false,
    stickyYellow: false,
  };
}
