import { getRuntimeConfig, isSecurityTrustAccepted, SECURITY_POLICY_VERSION } from './runtime-config.js';
import { buildSkillsPrompt, type Skill } from './skills.js';
import { buildContextPrompt, loadBootstrapFiles } from './workspace.js';
import fs from 'fs';
import path from 'path';

export type PromptHookName = 'bootstrap' | 'memory' | 'safety';
export type ExtendedPromptHookName = PromptHookName | 'proactivity';

export interface PromptHookContext {
  agentId: string;
  sessionSummary?: string | null;
  skills: Skill[];
  purpose?: 'conversation' | 'memory-flush';
  extraSafetyText?: string;
}

export interface PromptHookOutput {
  name: ExtendedPromptHookName;
  content: string;
}

interface PromptHook {
  name: ExtendedPromptHookName;
  isEnabled: (config: ReturnType<typeof getRuntimeConfig>) => boolean;
  run: (context: PromptHookContext) => string;
}

export function buildSessionSummaryPrompt(summary: string | null | undefined): string {
  const trimmed = summary?.trim() || '';
  if (!trimmed) return '';
  return [
    '## Session Summary',
    'Compressed context from earlier turns. Treat this as durable prior context.',
    '',
    trimmed,
  ].join('\n');
}

function buildBootstrapHook(context: PromptHookContext): string {
  const contextFiles = loadBootstrapFiles(context.agentId);
  const contextPrompt = buildContextPrompt(contextFiles);
  const skillsPrompt = buildSkillsPrompt(context.skills);
  return [contextPrompt, skillsPrompt].filter(Boolean).join('\n\n');
}

function buildMemoryHook(context: PromptHookContext): string {
  return buildSessionSummaryPrompt(context.sessionSummary);
}

function readSecurityPromptGuardrails(): string {
  const securityDocPath = path.join(process.cwd(), 'SECURITY.md');
  return fs.readFileSync(securityDocPath, 'utf-8').trim();
}

function buildSafetyHook(context: PromptHookContext): string {
  const runtime = getRuntimeConfig();
  const accepted = isSecurityTrustAccepted(runtime);
  const securityDoc = readSecurityPromptGuardrails();

  const lines = [
    '## Runtime Safety Guardrails',
    'Follow TRUST_MODEL.md and SECURITY.md boundaries, and use the least-privilege tools possible.',
    '',
    securityDoc,
    '',
    '## Tool Execution Discipline',
    'For implementation requests, do not reply with code-only output when files should be created.',
    'Create or modify files on disk first via file tools.',
    'Do not create or edit files via shell heredocs, echo redirects, sed, or awk.',
    'Use bash for execution/build/validation tasks, not for file authoring.',
    'After file changes, run commands only when asked; otherwise explicitly offer to run them immediately.',
    'Only skip file creation when the user explicitly asks for snippet-only or explanation-only output.',
  ];

  if (accepted) {
    lines.push(`Trust model acceptance status: accepted (policy ${SECURITY_POLICY_VERSION}).`);
  } else {
    lines.push('Trust model acceptance status: missing. Remain conservative and read-only unless user intent is explicit.');
  }

  if (context.purpose === 'memory-flush') {
    lines.push('This is a pre-compaction memory flush turn. Persist only durable memory worth keeping.');
  }

  if (context.extraSafetyText?.trim()) {
    lines.push(context.extraSafetyText.trim());
  }

  return lines.join('\n');
}

function buildProactivityHook(context: PromptHookContext): string {
  const runtime = getRuntimeConfig();
  const activeHours = runtime.proactive.activeHours;
  const delegation = runtime.proactive.delegation;

  const lines = [
    '## Proactive Behavior',
    'Act proactively when it improves outcomes, but stay aligned with user intent and safety constraints.',
    'Capture durable memory proactively using the `memory` tool when you learn stable preferences, constraints, recurring workflows, or decisions.',
    'When relevant historical context is likely missing, proactively run `session_search` before asking the user to repeat information.',
    '',
    '## Subagent Delegation Playbook',
    'Use `delegate` to offload narrow, self-contained subtasks to subagents.',
    '',
    '### When to use `delegate`',
    '- Reasoning-heavy subtasks (debugging, code review, research synthesis).',
    '- Context-heavy exploration that would flood the main context with intermediate output.',
    '- Multiple independent workstreams that can run in parallel.',
    '- Multi-stage pipelines where later steps depend on prior outputs.',
    '',
    '### When NOT to use `delegate`',
    '- A single direct tool call is sufficient.',
    '- A tiny mechanical change is faster to do directly.',
    '- The task requires direct user interaction or clarification.',
    '- Subtasks are tightly coupled and decomposition overhead outweighs benefit.',
    '',
    '### Never do these',
    '- Do NOT forward the user prompt verbatim to `delegate`.',
    '- Do NOT spawn a subagent for every todo item by default.',
    '- Do NOT duplicate work already assigned to active delegations.',
    '- Do NOT poll, sleep, or repeatedly check for delegated completion.',
    '',
    '### Delegation mode selection',
    '- `single`: one focused subtask.',
    '- `parallel`: independent subtasks (1-6) that do not depend on each other.',
    '- `chain`: dependent stages where later prompts use `{previous}`.',
    '',
    '### Context checklist for delegated prompts',
    '- Explicit goal and success criteria.',
    '- Relevant file paths / modules / search scope.',
    '- Exact errors, symptoms, or constraints.',
    '- Expected outcome type: research-only vs implementation.',
    '- Any required output format (bullets, patch plan, file list, etc.).',
    '',
    '### Decomposition heuristic',
    '- If task is broad or ambiguous: run a scout-style `single` delegation first to map code/context.',
    '- If design choices are non-trivial: run a planner-style stage next (often via `chain`).',
    '- Split independent implementation/analysis branches with `parallel`.',
    '- Use `chain` when each step depends on prior findings.',
    '- Keep delegated tasks narrow enough to complete autonomously.',
    '',
    '### Post-spawn behavior',
    '- Delegation completion is push-based and may auto-announce.',
    '- Continue useful work; do not busy-wait.',
    '- When sharing delegated outcomes, synthesize concise user-facing takeaways instead of dumping raw transcripts.',
    '',
    '<example>',
    'Context: user reports a bug that likely spans many files.',
    'Good: delegate a focused scout task that finds root cause and affected files.',
    'Why: isolate context-heavy investigation and return only actionable diagnosis.',
    '</example>',
    '',
    '<example>',
    'Context: user asks for a one-line rename in one known file.',
    'Good: edit directly without delegation.',
    'Why: subagent overhead adds no value.',
    '</example>',
    '',
    `Delegation limits: maxConcurrent=${delegation.maxConcurrent}, maxDepth=${delegation.maxDepth}, maxPerTurn=${delegation.maxPerTurn}.`,
  ];

  if (activeHours.enabled) {
    const timezone = activeHours.timezone || 'local runtime timezone';
    lines.push(
      `Active-hours guard: avoid non-urgent proactive messaging outside ${String(activeHours.startHour).padStart(2, '0')}:00-${String(activeHours.endHour).padStart(2, '0')}:00 (${timezone}).`,
    );
  } else {
    lines.push('Active-hours guard: disabled.');
  }

  if (context.purpose === 'memory-flush') {
    lines.push('This is a memory-flush pass. Prioritize preserving durable context over immediate user-facing output.');
  }

  return lines.join('\n');
}

const PROMPT_HOOKS: PromptHook[] = [
  {
    name: 'bootstrap',
    isEnabled: (config) => config.promptHooks.bootstrapEnabled,
    run: buildBootstrapHook,
  },
  {
    name: 'memory',
    isEnabled: (config) => config.promptHooks.memoryEnabled,
    run: buildMemoryHook,
  },
  {
    name: 'safety',
    isEnabled: (config) => config.promptHooks.safetyEnabled,
    run: buildSafetyHook,
  },
  {
    name: 'proactivity',
    isEnabled: (config) => config.promptHooks.proactivityEnabled,
    run: buildProactivityHook,
  },
];

export function runPromptHooks(context: PromptHookContext): PromptHookOutput[] {
  const runtime = getRuntimeConfig();
  const output: PromptHookOutput[] = [];

  for (const hook of PROMPT_HOOKS) {
    if (!hook.isEnabled(runtime)) continue;
    const content = hook.run(context).trim();
    if (!content) continue;
    output.push({ name: hook.name, content });
  }

  return output;
}

export function buildSystemPromptFromHooks(context: PromptHookContext): string {
  return runPromptHooks(context)
    .map((hookResult) => hookResult.content)
    .join('\n\n');
}
