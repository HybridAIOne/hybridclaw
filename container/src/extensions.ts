type RuntimeEventName =
  | 'before_agent_start'
  | 'before_model_call'
  | 'after_model_call'
  | 'model_retry'
  | 'model_error'
  | 'before_tool_call'
  | 'after_tool_call'
  | 'turn_end';

interface RuntimeEventPayload {
  event: RuntimeEventName;
  [key: string]: unknown;
}

interface RuntimeExtension {
  name: string;
  onEvent?: (payload: RuntimeEventPayload) => void | Promise<void>;
  onBeforeToolCall?: (toolName: string, args: Record<string, unknown>) => string | null | Promise<string | null>;
  onAfterToolCall?: (toolName: string, args: Record<string, unknown>, result: string) => void | Promise<void>;
}

const DANGEROUS_FILE_CONTENT_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\brm\s+-rf\s+\/(\s|$)/i,
    reason: 'Detected destructive root delete pattern (`rm -rf /`) in file content.',
  },
  {
    re: /:\(\)\s*\{.*\};\s*:/i,
    reason: 'Detected fork-bomb pattern in file content.',
  },
  {
    re: /\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b/i,
    reason: 'Detected remote shell execution pattern (`curl | sh`) in file content.',
  },
];

const DANGEROUS_BASH_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  {
    re: /\b(cat|sed|awk)\b[^|]*\.(env|pem|key|p12)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate sensitive local files.',
  },
  {
    re: /\b(printenv|env)\b[^|]*(\|\s*(curl|wget)|>\s*\/dev\/tcp)/i,
    reason: 'Command appears to exfiltrate environment variables.',
  },
];

const securityHookExtension: RuntimeExtension = {
  name: 'security-hook',
  onBeforeToolCall: (toolName, args) => {
    if (toolName === 'write' || toolName === 'edit') {
      const content = toolName === 'write'
        ? String(args.contents || '')
        : String(args.new || '');
      for (const pattern of DANGEROUS_FILE_CONTENT_PATTERNS) {
        if (pattern.re.test(content)) return pattern.reason;
      }
    }

    if (toolName === 'bash') {
      const command = String(args.command || '');
      for (const pattern of DANGEROUS_BASH_PATTERNS) {
        if (pattern.re.test(command)) return pattern.reason;
      }
    }

    return null;
  },
};

const runtimeExtensions: RuntimeExtension[] = [securityHookExtension];

function parseArgs(argsJson: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(argsJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function emitRuntimeEvent(payload: RuntimeEventPayload): Promise<void> {
  for (const ext of runtimeExtensions) {
    if (!ext.onEvent) continue;
    try {
      await ext.onEvent(payload);
    } catch {
      // Best effort: extension errors should not break request handling.
    }
  }
}

export async function runBeforeToolHooks(toolName: string, argsJson: string): Promise<string | null> {
  const args = parseArgs(argsJson);
  for (const ext of runtimeExtensions) {
    if (!ext.onBeforeToolCall) continue;
    try {
      const blocked = await ext.onBeforeToolCall(toolName, args);
      if (blocked) {
        await emitRuntimeEvent({
          event: 'before_tool_call',
          toolName,
          blocked: true,
          extension: ext.name,
          reason: blocked,
        });
        return blocked;
      }
    } catch {
      // ignore broken extensions
    }
  }
  await emitRuntimeEvent({ event: 'before_tool_call', toolName, blocked: false });
  return null;
}

export async function runAfterToolHooks(toolName: string, argsJson: string, result: string): Promise<void> {
  const args = parseArgs(argsJson);
  for (const ext of runtimeExtensions) {
    if (!ext.onAfterToolCall) continue;
    try {
      await ext.onAfterToolCall(toolName, args, result);
    } catch {
      // ignore broken extensions
    }
  }
  await emitRuntimeEvent({ event: 'after_tool_call', toolName });
}
