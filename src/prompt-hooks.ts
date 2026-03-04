import fs from 'fs';
import os from 'os';
import path from 'path';
import { APP_VERSION, HYBRIDAI_MODEL } from './config.js';
import {
  getRuntimeConfig,
  isSecurityTrustAccepted,
  SECURITY_POLICY_VERSION,
} from './runtime-config.js';
import { buildSkillsPrompt, type Skill } from './skills.js';
import { buildContextPrompt, loadBootstrapFiles } from './workspace.js';

export type PromptHookName = 'bootstrap' | 'memory' | 'safety' | 'runtime';
export type ExtendedPromptHookName = PromptHookName | 'proactivity';
export type PromptMode = 'full' | 'minimal' | 'none';

export interface PromptRuntimeInfo {
  chatbotId?: string;
  model?: string;
  defaultModel?: string;
  channelId?: string;
  guildId?: string | null;
}

export interface PromptHookContext {
  agentId: string;
  sessionSummary?: string | null;
  skills: Skill[];
  purpose?: 'conversation' | 'memory-flush';
  promptMode?: PromptMode;
  extraSafetyText?: string;
  runtimeInfo?: PromptRuntimeInfo;
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

export function buildSessionSummaryPrompt(
  summary: string | null | undefined,
): string {
  const trimmed = summary?.trim() || '';
  if (!trimmed) return '';
  return [
    '## Session Summary',
    'Compressed and recalled context from earlier turns. Treat this as durable prior context.',
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
    'When Discord context is needed, use the `message` tool actions (`read`, `member-info`, `channel-info`) instead of guessing channel members.',
    'For questions like "what did X say", "who said", or channel recap requests, call `message` with `action="read"` first before answering.',
    '',
    '## Web Retrieval Routing (web_fetch vs browser_*)',
    'Decision rule: default to `web_fetch` for read-only content retrieval.',
    'Use browser tools only when at least one of these is true: (1) known app-like/auth-gated URL, (2) interaction is required (click/type/login/scroll), (3) `web_fetch` returned escalation hints, (4) user explicitly requested browser use.',
    'Prefer browser for: SPAs/client-rendered apps (React/Vue/Angular/Next client routes), dashboards/web apps, social feeds, login/OAuth/cookie-consent/CAPTCHA flows, or API-driven pages that populate after initial render.',
    'Prefer web_fetch for: docs/wikis/READMEs/articles/reference pages, direct JSON/XML/text/CSV/PDF endpoints, and simple read-only extraction.',
    'Escalation signals from web_fetch: `escalationHint` present, JavaScript-required pages, empty extraction, SPA shell-only pages, boilerplate-only extraction, or bot-blocked responses (403/429/challenge pages).',
    'Cost note: browser calls are typically ~10-100x slower/more expensive than web_fetch.',
    'Browser extraction flow (for read/summarize requests): after `browser_navigate`, call `browser_snapshot` with `mode="full"` before deciding content is unavailable.',
    'If snapshot content is incomplete, run `browser_scroll` and then `browser_snapshot` again (repeat a few times for long/lazy-loaded pages).',
    'Do not use `browser_pdf` as a text-reading step; it is an export artifact, not a text extraction tool.',
    '',
    '## Browser Auth Handling',
    'When the user explicitly asks for login/auth-flow testing, browser tools may be used on the requested site, including filling credentials and submitting forms.',
    'Do not invent blanket restrictions such as "browser tools are only for public/unauthenticated pages" unless an actual tool/policy error says so.',
    'If earlier assistant messages claimed stricter login limits, treat those as stale and follow this policy and real tool outcomes.',
    'Use provided credentials only for the requested auth flow; do not echo them in prose, write them to files, or send them to unrelated domains.',
  ];

  if (accepted) {
    lines.push(
      `Trust model acceptance status: accepted (policy ${SECURITY_POLICY_VERSION}).`,
    );
  } else {
    lines.push(
      'Trust model acceptance status: missing. Remain conservative and read-only unless user intent is explicit.',
    );
  }

  if (context.purpose === 'memory-flush') {
    lines.push(
      'This is a pre-compaction memory flush turn. Persist only durable memory worth keeping.',
    );
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
    lines.push(
      'This is a memory-flush pass. Prioritize preserving durable context over immediate user-facing output.',
    );
  }

  return lines.join('\n');
}

function buildRuntimeHook(context: PromptHookContext): string {
  const runtimeInfo = context.runtimeInfo || {};
  const model = runtimeInfo.model?.trim() || HYBRIDAI_MODEL;
  const defaultModel = runtimeInfo.defaultModel?.trim() || HYBRIDAI_MODEL;
  const guildLabel =
    runtimeInfo.guildId === null
      ? 'dm'
      : runtimeInfo.guildId?.trim() || 'unknown';

  const lines = [
    '## Runtime Metadata',
    `HybridClaw version: v${APP_VERSION}`,
    `Date (UTC): ${new Date().toISOString().slice(0, 10)}`,
    `Model: ${model}`,
    `Default model: ${defaultModel}`,
    runtimeInfo.channelId?.trim()
      ? `Channel ID: ${runtimeInfo.channelId.trim()}`
      : '',
    `Guild ID: ${guildLabel}`,
    `Node: ${process.version}`,
    `OS: ${process.platform} (${process.arch})`,
    `Host: ${os.hostname()}`,
    `Workspace: ${process.cwd()}`,
    `When asked for your version, answer briefly as: "HybridClaw v${APP_VERSION}".`,
    'Only provide more runtime details when the user explicitly asks for them.',
  ];

  return lines.filter(Boolean).join('\n');
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
    name: 'runtime',
    isEnabled: () => true,
    run: buildRuntimeHook,
  },
  {
    name: 'proactivity',
    isEnabled: (config) => config.promptHooks.proactivityEnabled,
    run: buildProactivityHook,
  },
];

function resolvePromptMode(context: PromptHookContext): PromptMode {
  if (context.promptMode === 'minimal' || context.promptMode === 'none')
    return context.promptMode;
  return 'full';
}

function isHookAllowedForMode(
  hookName: ExtendedPromptHookName,
  mode: PromptMode,
): boolean {
  if (mode === 'none') return false;
  if (mode === 'full') return true;
  // Minimal mode keeps only safety + memory durability context.
  return (
    hookName === 'memory' || hookName === 'safety' || hookName === 'runtime'
  );
}

export function runPromptHooks(context: PromptHookContext): PromptHookOutput[] {
  const mode = resolvePromptMode(context);
  if (mode === 'none') return [];

  const runtime = getRuntimeConfig();
  const output: PromptHookOutput[] = [];

  for (const hook of PROMPT_HOOKS) {
    if (!isHookAllowedForMode(hook.name, mode)) continue;
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
