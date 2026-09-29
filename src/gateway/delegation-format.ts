import type {
  ArtifactMetadata,
  ToolProgressEvent,
} from '../types/execution.js';
import { formatDurationMs } from '../utils/text-format.js';
import type {
  DelegationCompletionEntry,
  DelegationMode,
  DelegationStatusEntry,
} from './delegation-plan.js';
import { abbreviateForUser } from './gateway-formatting.js';

const MAX_DELEGATION_USER_CHARS = 500;

function formatDelegationTokenCount(tokenCount?: number): string {
  if (!tokenCount || tokenCount <= 0) return '';
  if (tokenCount < 1_000) return `${tokenCount} tokens`;
  return `${(tokenCount / 1_000).toFixed(1)}k tokens`;
}

function parseToolProgressPreviewObject(
  preview: string,
): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(preview);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function firstStringToolArg(
  args: Record<string, unknown>,
  keys: string[],
): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const strings = value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
      if (strings.length > 0) return strings.join(', ');
    }
  }
  return '';
}

function extractToolProgressPreviewValue(preview: string, key: string): string {
  const match = preview.match(new RegExp(`"${key}"\\s*:\\s*"([^"]{1,200})`));
  return match?.[1]?.trim() || '';
}

export function formatDelegationToolDetail(event: ToolProgressEvent): string {
  const preview = String(event.preview || '').trim();
  if (!preview) return '';

  const args = parseToolProgressPreviewObject(preview);
  if (args) {
    const toolName = event.toolName.toLowerCase();
    const url = firstStringToolArg(args, ['url', 'href', 'uri']);
    if (
      url &&
      (toolName.includes('web') ||
        toolName.includes('browser') ||
        toolName.includes('http'))
    ) {
      return abbreviateForUser(url, 96);
    }
    const query = firstStringToolArg(args, ['query', 'q', 'search_query']);
    if (query) return abbreviateForUser(query, 96);
    const pathValue = firstStringToolArg(args, [
      'path',
      'file',
      'file_path',
      'cwd',
      'workdir',
    ]);
    if (pathValue) return abbreviateForUser(pathValue, 96);
    const command = firstStringToolArg(args, ['cmd', 'command']);
    if (command) return abbreviateForUser(command, 96);
    const selector = firstStringToolArg(args, ['selector', 'ref_id', 'id']);
    if (selector) return abbreviateForUser(selector, 96);
  }

  for (const key of ['url', 'href', 'uri', 'query', 'q', 'path', 'cmd']) {
    const value = extractToolProgressPreviewValue(preview, key);
    if (value) return abbreviateForUser(value, 96);
  }

  return abbreviateForUser(preview, 96);
}

export function formatDelegationCompletion(params: {
  mode: DelegationMode;
  label?: string;
  entries: DelegationCompletionEntry[];
  totalDurationMs: number;
}): { forUser: string; forLLM: string; artifacts?: ArtifactMetadata[] } {
  const { mode, label, entries, totalDurationMs } = params;
  const completedCount = entries.filter(
    (entry) => entry.run.status === 'completed',
  ).length;
  const failedCount = entries.length - completedCount;
  const overallStatus =
    failedCount === 0
      ? 'completed'
      : completedCount === 0
        ? 'failed'
        : 'partial';
  const heading = label?.trim()
    ? `[Delegate: ${label.trim()}]`
    : `[Delegate ${mode}]`;

  const userLines = [
    `${heading} ${overallStatus} (${completedCount}/${entries.length} completed, ${formatDurationMs(totalDurationMs)}).`,
  ];
  for (const entry of entries) {
    if (entry.run.status === 'completed') {
      userLines.push(
        `- ${entry.title}: ${abbreviateForUser(entry.run.result || '', MAX_DELEGATION_USER_CHARS)}`,
      );
    } else {
      userLines.push(
        `- ${entry.title}: ${entry.run.status} (${abbreviateForUser(entry.run.error || 'Unknown error', MAX_DELEGATION_USER_CHARS)})`,
      );
    }
  }

  const llmLines = [
    `${heading} ${overallStatus}`,
    `mode: ${mode}`,
    `completed: ${completedCount}/${entries.length}`,
    `duration_ms_total: ${totalDurationMs}`,
    '',
  ];
  for (const entry of entries) {
    llmLines.push(`## ${entry.title}`);
    llmLines.push(`status: ${entry.run.status}`);
    llmLines.push(`session_id: ${entry.run.sessionId}`);
    llmLines.push(`model: ${entry.run.model}`);
    llmLines.push(`duration_ms: ${entry.run.durationMs}`);
    llmLines.push(`attempts: ${entry.run.attempts}`);
    if (entry.run.toolsUsed.length > 0) {
      llmLines.push(`tools_used: ${entry.run.toolsUsed.join(', ')}`);
    }
    if (entry.run.status === 'completed') {
      llmLines.push('');
      llmLines.push(entry.run.result || '(empty result)');
    } else {
      llmLines.push(`error: ${entry.run.error || 'Unknown error'}`);
    }
    llmLines.push('');
  }

  const artifacts: ArtifactMetadata[] = [];
  const seenArtifactKeys = new Set<string>();
  for (const entry of entries) {
    for (const artifact of entry.run.artifacts || []) {
      if (!artifact?.path) continue;
      const key = `${artifact.path}|${artifact.filename}|${artifact.mimeType}`;
      if (seenArtifactKeys.has(key)) continue;
      seenArtifactKeys.add(key);
      artifacts.push(artifact);
    }
  }

  return {
    forUser: abbreviateForUser(userLines.join('\n'), MAX_DELEGATION_USER_CHARS),
    forLLM: llmLines.join('\n').trimEnd(),
    ...(artifacts.length > 0 ? { artifacts } : {}),
  };
}

export function formatDelegationStatus(params: {
  label?: string;
  entries: DelegationStatusEntry[];
  parentModel?: string;
}): string {
  const runningCount = params.entries.filter(
    (entry) => entry.status === 'running' || entry.status === 'queued',
  ).length;
  const finishedCount = params.entries.length - runningCount;
  const distinctDelegateModels = Array.from(
    new Set(
      params.entries
        .map((entry) => entry.model.trim())
        .filter(
          (model) =>
            model &&
            (!params.parentModel ||
              model.localeCompare(params.parentModel, undefined, {
                sensitivity: 'accent',
              }) !== 0),
        ),
    ),
  );
  const modelSuffix =
    distinctDelegateModels.length > 0
      ? ` (${distinctDelegateModels.join(', ')})`
      : '';
  const heading =
    runningCount > 0
      ? `Running ${runningCount} delegate jobs${modelSuffix}`
      : `${finishedCount} delegate jobs finished${modelSuffix}`;
  const lines = ['[Delegate Status]', heading];
  params.entries.forEach((entry, index) => {
    const prefix = index === params.entries.length - 1 ? '└' : '├';
    const donePrefix = index === params.entries.length - 1 ? '   └' : '│  └';
    const toolLabel =
      entry.toolUses === 1 ? '1 tool use' : `${entry.toolUses} tool uses`;
    const tokenLabel = formatDelegationTokenCount(entry.tokenCount);
    const statusLabel =
      entry.status === 'queued'
        ? 'initializing'
        : entry.status === 'running'
          ? entry.currentTool
            ? `running ${entry.currentTool}${entry.currentToolDetail ? ` ${entry.currentToolDetail}` : ''}`
            : entry.lastTool
              ? `thinking after ${entry.lastTool}${entry.lastToolDetail ? ` ${entry.lastToolDetail}` : ''}`
              : 'starting'
          : entry.status;
    lines.push(
      `${prefix} ${entry.title} · ${toolLabel}${tokenLabel ? ` · ${tokenLabel}` : ''}`,
    );
    lines.push(
      `${donePrefix} ${statusLabel === 'completed' ? 'Done' : statusLabel}`,
    );
  });
  return lines.join('\n');
}
