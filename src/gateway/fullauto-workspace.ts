import fs from 'node:fs';
import path from 'node:path';
import { resolveAgentForRequest } from '../agents/agent-registry.js';
import { FULLAUTO_DEFAULT_PROMPT } from '../config/config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import type { Session } from '../types/session.js';

const FULLAUTO_STATE_DIRNAME = 'fullauto';
const FULLAUTO_GOAL_FILENAME_PREFIX = 'GOAL_';
const FULLAUTO_LEARNING_FILENAME_PREFIX = 'LEARNING_';
const FULLAUTO_RUN_LOG_FILENAME_PREFIX = 'RUN_LOG_';

export function resolveFullAutoPrompt(session: Session): string {
  return session.full_auto_prompt?.trim() || FULLAUTO_DEFAULT_PROMPT;
}

function resolveFullAutoRunId(session: Session): string {
  const raw = session.full_auto_started_at?.trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed)
        .toISOString()
        .replace(/[-:]/g, '')
        .replace('.', '_');
    }
    const normalized = raw.replace(/[^a-zA-Z0-9_-]/g, '_');
    if (normalized) return normalized;
  }
  return 'legacy';
}

function getFullAutoWorkspaceState(session: Session): {
  workspacePath: string;
  stateDirPath: string;
  runId: string;
  goalPath: string;
  goalExists: boolean;
  learningsPath: string;
  learningsExists: boolean;
  runLogPath: string;
  runLogExists: boolean;
} {
  const { agentId } = resolveAgentForRequest({ session });
  const workspacePath = path.resolve(agentWorkspaceDir(agentId));
  const runId = resolveFullAutoRunId(session);
  const stateDirPath = path.join(workspacePath, FULLAUTO_STATE_DIRNAME);
  const goalPath = path.join(
    stateDirPath,
    `${FULLAUTO_GOAL_FILENAME_PREFIX}${runId}.md`,
  );
  const learningsPath = path.join(
    stateDirPath,
    `${FULLAUTO_LEARNING_FILENAME_PREFIX}${runId}.md`,
  );
  const runLogPath = path.join(
    stateDirPath,
    `${FULLAUTO_RUN_LOG_FILENAME_PREFIX}${runId}.md`,
  );
  return {
    workspacePath,
    stateDirPath,
    runId,
    goalPath,
    goalExists: fs.existsSync(goalPath),
    learningsPath,
    learningsExists: fs.existsSync(learningsPath),
    runLogPath,
    runLogExists: fs.existsSync(runLogPath),
  };
}

export function appendFullAutoRunLogEntry(params: {
  session: Session;
  heading: string;
  lines: string[];
}): void {
  const workspace = getFullAutoWorkspaceState(params.session);
  fs.mkdirSync(workspace.stateDirPath, { recursive: true });
  if (!workspace.runLogExists) {
    fs.writeFileSync(
      workspace.runLogPath,
      [
        '# Full-Auto Run Log',
        '',
        `Run ID: ${workspace.runId}`,
        `Started: ${params.session.full_auto_started_at || new Date().toISOString()}`,
        '',
      ].join('\n'),
      'utf8',
    );
  }
  const entry = [
    `## ${new Date().toISOString()} - ${params.heading}`,
    ...params.lines.filter((line) => line.trim().length > 0),
    '',
  ].join('\n');
  fs.appendFileSync(workspace.runLogPath, entry, 'utf8');
}

export function looksLikeSyntheticFullAutoPrompt(content: string): boolean {
  return (
    content.includes('Durable goal state:') &&
    content.includes('FULLAUTO mode instructions:')
  );
}

export function describeFullAutoWorkspaceSummary(
  session: Session,
  seeded: {
    goalCreated: boolean;
    learningsCreated: boolean;
    runLogCreated: boolean;
  },
): string {
  const workspace = getFullAutoWorkspaceState(session);
  const goalState = seeded.goalCreated
    ? 'created'
    : workspace.goalExists
      ? 'present'
      : 'missing';
  const learningsState = seeded.learningsCreated
    ? 'created'
    : workspace.learningsExists
      ? 'present'
      : 'missing';
  const runLogState = seeded.runLogCreated
    ? 'created'
    : workspace.runLogExists
      ? 'present'
      : 'missing';
  return `Workspace files: fullauto/GOAL_${workspace.runId}.md ${goalState}, fullauto/LEARNING_${workspace.runId}.md ${learningsState}, fullauto/RUN_LOG_${workspace.runId}.md ${runLogState}`;
}

export function buildFullAutoOperatingContract(
  session: Session,
  mode: 'background' | 'supervised',
): string {
  const workspace = getFullAutoWorkspaceState(session);
  const lines = [
    'FULLAUTO mode is active for this session.',
    mode === 'supervised'
      ? 'The latest user message is a supervised intervention. Respond to it directly, adapt the plan, and then continue the broader loop unless the user explicitly disables full-auto.'
      : 'Do not stop after one update. After each meaningful step, choose the next best step and keep going without waiting for another nudge.',
    'Stop only if the human explicitly says `/stop` or `fullauto off`, or if a hard safety/approval boundary blocks further action.',
    'After meaningful work, briefly self-evaluate: what changed, what failed, and what to do next.',
    'After each successful turn, a separate learning-writer subagent will rewrite the active learning-state file from your work. Make your output concrete enough for that handoff.',
    workspace.goalExists
      ? `Use \`${path.relative(workspace.workspacePath, workspace.goalPath)}\` as the high-level objective anchor and re-read it before major pivots.`
      : 'If the task has a durable multi-step objective, create or refresh the current goal file to keep the loop aligned.',
    workspace.learningsExists
      ? `Keep \`${path.relative(workspace.workspacePath, workspace.learningsPath)}\` aligned with the current state of the run; prefer updating durable state over repeating the same work.`
      : 'Create and maintain the current learning-state file when the task spans multiple cycles.',
    'If you are repeating yourself or not making progress, change tactic instead of looping on the same action.',
  ];
  return lines.join('\n');
}
