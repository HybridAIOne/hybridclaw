import os from 'node:os';
import type { ChannelInfo } from '../channels/channel.js';
import { resolveChannelMessageToolHints } from '../channels/prompt-adapters.js';
import {
  APP_VERSION,
  CONTAINER_SANDBOX_MODE,
  HYBRIDAI_MODEL,
} from '../config/config.js';
import {
  getRuntimeConfig,
  isSecurityTrustAccepted,
  SECURITY_POLICY_VERSION,
} from '../config/runtime-config.js';
import { resolveModelProvider } from '../providers/factory.js';
import { formatModelForDisplay } from '../providers/model-names.js';
import { readRuntimeInstructionFile } from '../security/instruction-integrity.js';
import {
  buildSessionContextPrompt,
  type SessionContext,
} from '../session/session-context.js';
import {
  buildSkillsPrompt,
  type Skill,
  type SkillInvocation,
} from '../skills/skills.js';
import { buildContextPrompt, loadBootstrapFiles } from '../workspace.js';
import { SILENT_REPLY_TOKEN } from './silent-reply.js';
import { buildToolsSummary } from './tool-summary.js';

export type PromptHookName =
  | 'bootstrap'
  | 'memory'
  | 'retrieval'
  | 'safety'
  | 'runtime'
  | 'session-context';
export type ExtendedPromptHookName = PromptHookName | 'proactivity';
export type WorkspacePromptPartName =
  | 'agents'
  | 'soul'
  | 'identity'
  | 'user'
  | 'tools'
  | 'memory-file'
  | 'heartbeat'
  | 'bootstrap-file'
  | 'opening'
  | 'boot';
export type PromptPartName =
  | ExtendedPromptHookName
  | WorkspacePromptPartName
  | 'skills';
export type PromptMode = 'full' | 'minimal' | 'none';
export const MESSAGE_SEND_SILENT_REPLY_TOKEN = SILENT_REPLY_TOKEN;
export const PROMPT_PART_NAMES: PromptPartName[] = [
  'bootstrap',
  'memory',
  'retrieval',
  'safety',
  'runtime',
  'session-context',
  'proactivity',
  'skills',
  'agents',
  'soul',
  'identity',
  'user',
  'tools',
  'memory-file',
  'heartbeat',
  'bootstrap-file',
  'opening',
  'boot',
];

export interface PromptRuntimeInfo {
  chatbotId?: string;
  model?: string;
  defaultModel?: string;
  channelType?: string;
  channelId?: string;
  guildId?: string | null;
  channel?: ChannelInfo;
  sessionContext?: SessionContext;
  workspacePath?: string;
}

export interface PromptHookContext {
  agentId: string;
  sessionSummary?: string | null;
  retrievedContext?: string | null;
  skills: Skill[];
  explicitSkillInvocation?: SkillInvocation | null;
  purpose?: 'conversation' | 'memory-flush';
  promptMode?: PromptMode;
  includePromptParts?: PromptPartName[];
  omitPromptParts?: PromptPartName[];
  extraSafetyText?: string;
  runtimeInfo?: PromptRuntimeInfo;
  allowedTools?: string[];
  blockedTools?: string[];
}

export interface PromptHookOutput {
  name: ExtendedPromptHookName;
  content: string;
}

interface PromptHook {
  name: ExtendedPromptHookName;
  isEnabled: (
    config: ReturnType<typeof getRuntimeConfig>,
    context: PromptHookContext,
  ) => boolean;
  run: (context: PromptHookContext) => string;
}

const WORKSPACE_FILE_PROMPT_PARTS: Record<string, WorkspacePromptPartName> = {
  'AGENTS.md': 'agents',
  'SOUL.md': 'soul',
  'IDENTITY.md': 'identity',
  'USER.md': 'user',
  'TOOLS.md': 'tools',
  'MEMORY.md': 'memory-file',
  'HEARTBEAT.md': 'heartbeat',
  'BOOTSTRAP.md': 'bootstrap-file',
  'OPENING.md': 'opening',
  'BOOT.md': 'boot',
};

const BOOTSTRAP_SUBPARTS = new Set<PromptPartName>([
  'skills',
  'agents',
  'soul',
  'identity',
  'user',
  'tools',
  'memory-file',
  'heartbeat',
  'bootstrap-file',
  'opening',
  'boot',
]);

function buildPromptPartSelection(context: PromptHookContext): {
  include: Set<PromptPartName>;
  omit: Set<PromptPartName>;
} {
  return {
    include: new Set(context.includePromptParts || []),
    omit: new Set(context.omitPromptParts || []),
  };
}

function selectionHasBootstrapContent(selection: {
  include: Set<PromptPartName>;
}): boolean {
  for (const part of BOOTSTRAP_SUBPARTS) {
    if (selection.include.has(part)) return true;
  }
  return false;
}

function isBootstrapHookSelected(selection: {
  include: Set<PromptPartName>;
  omit: Set<PromptPartName>;
}): boolean {
  if (selection.omit.has('bootstrap')) return false;
  if (selection.include.size === 0) return true;
  return (
    selection.include.has('bootstrap') ||
    selectionHasBootstrapContent(selection)
  );
}

function isHookSelected(
  hookName: ExtendedPromptHookName,
  context: PromptHookContext,
): boolean {
  const selection = buildPromptPartSelection(context);
  if (hookName === 'bootstrap') {
    return isBootstrapHookSelected(selection);
  }
  if (selection.omit.has(hookName)) return false;
  if (selection.include.size === 0) return true;
  return selection.include.has(hookName);
}

function isBootstrapPartSelected(
  part: PromptPartName,
  context: PromptHookContext,
): boolean {
  const selection = buildPromptPartSelection(context);
  if (!isBootstrapHookSelected(selection)) return false;
  if (selection.omit.has(part)) return false;
  if (selection.include.size === 0) return true;
  if (selection.include.has('bootstrap')) return true;
  return selection.include.has(part);
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

function buildSkillsSection(skillsPrompt: string): string {
  const trimmed = skillsPrompt.trim();
  if (!trimmed) return '';
  if (!trimmed.includes('<available_skills>')) return trimmed;

  return [
    '## Skills (mandatory)',
    'Before replying: scan `<available_skills>` `<description>` entries.',
    '- If the user explicitly names a skill from `<available_skills>`, treat that skill as selected.',
    '- If exactly one skill clearly applies: read its SKILL.md at `<location>` with `read`, then follow it.',
    '- If multiple could apply: choose the most specific one, then read/follow it.',
    '- If none clearly apply: do not read any SKILL.md.',
    '- Do not claim a listed skill is unavailable when the user named it.',
    '- Treat paths under `skills/` as bundled, read-only skill assets for normal user work.',
    '- For normal user work, put generated scripts in workspace `scripts/` or the workspace root. Only write under `skills/` when the user explicitly asked to create or edit a skill.',
    '- Before running a helper under `skills/.../scripts/...`, make sure that exact path came from the skill instructions or from a file read/listing in this turn. Do not invent helper names or guess that a sibling script exists.',
    '',
    trimmed,
  ].join('\n');
}

function buildBootstrapHook(context: PromptHookContext): string {
  const contextFiles = loadBootstrapFiles(context.agentId).filter((file) => {
    const part = WORKSPACE_FILE_PROMPT_PARTS[file.name];
    return part ? isBootstrapPartSelected(part, context) : true;
  });
  const contextPrompt = buildContextPrompt(contextFiles);
  const skillsPrompt = context.explicitSkillInvocation
    ? ''
    : isBootstrapPartSelected('skills', context)
      ? buildSkillsSection(buildSkillsPrompt(context.skills))
      : '';
  return [contextPrompt, skillsPrompt].filter(Boolean).join('\n\n');
}

function buildMemoryHook(context: PromptHookContext): string {
  return buildSessionSummaryPrompt(context.sessionSummary);
}

export function buildRetrievedContextPrompt(
  retrievedContext: string | null | undefined,
): string {
  const trimmed = retrievedContext?.trim() || '';
  if (!trimmed) return '';
  return [
    '## Retrieved Context',
    'Fresh external context retrieved for the current user request. This is not prior session memory.',
    'If this section directly answers the request, answer from it even when the referenced source path is not available to workspace file tools.',
    '',
    trimmed,
  ].join('\n');
}

function buildRetrievalHook(context: PromptHookContext): string {
  return buildRetrievedContextPrompt(context.retrievedContext);
}

function buildSessionContextHook(context: PromptHookContext): string {
  const sessionContext = context.runtimeInfo?.sessionContext;
  if (!sessionContext) return '';
  return buildSessionContextPrompt(sessionContext);
}

function readSecurityPromptGuardrails(): string {
  return readRuntimeInstructionFile('SECURITY.md');
}

function buildSafetyHook(context: PromptHookContext): string {
  const runtime = getRuntimeConfig();
  const accepted = isSecurityTrustAccepted(runtime);
  const securityDoc = readSecurityPromptGuardrails();
  const toolsSummary = buildToolsSummary({
    allowedTools: context.allowedTools,
    blockedTools: context.blockedTools,
  });
  const channelMessageToolHints = resolveChannelMessageToolHints({
    runtimeInfo: {
      channel: context.runtimeInfo?.channel,
      channelType: context.runtimeInfo?.channelType,
      channelId: context.runtimeInfo?.channelId,
      guildId: context.runtimeInfo?.guildId,
    },
  });

  const lines = [
    '## Runtime Safety Guardrails',
    'Follow TRUST_MODEL.md and SECURITY.md boundaries, and use the least-privilege tools possible.',
    '',
    ...(toolsSummary ? [toolsSummary, ''] : []),
    '## Tool Call Style',
    'Default: do not narrate routine, low-risk tool calls; just call the tool.',
    'Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions, or when the user explicitly asks.',
    'Keep narration brief and value-dense; avoid repeating obvious steps.',
    'If the user has already asked you to perform an action, do not ask for a separate natural-language "yes" just to trigger approvals; attempt the tool call and let the runtime approval flow interrupt if approval is required.',
    'If a requested action is blocked only by a missing dependency or another narrow prerequisite, attempt the minimal prerequisite step needed to complete the request instead of turning it into a follow-up multiple-choice question; let the runtime approval flow interrupt if approval is required.',
    'When a direct first-class tool exists, use it instead of asking the user to run equivalent CLI commands or doing indirect rediscovery.',
    'If the relevant content is already available directly in the current turn, injected `<file>` content, or `[PDFContext]`, answer from that content first before reading skills or searching for the same artifact again.',
    '',
    securityDoc,
    '',
    '## Tool Execution Discipline',
    'For implementation requests, do not reply with code-only output when files should be created.',
    'Create or modify files on disk first via file tools.',
    'Do not create or edit files via shell heredocs, echo redirects, sed, or awk.',
    'Use bash for execution/build/validation tasks, not for file authoring.',
    CONTAINER_SANDBOX_MODE === 'host'
      ? 'Files tools (`read`, `write`, `edit`, `delete`, `glob`, `grep`) operate relative to the workspace directory shown in Runtime Metadata. Use `bash` for absolute paths outside the workspace.'
      : 'Files tools (`read`, `write`, `edit`, `delete`, `glob`, `grep`) are workspace-bound, but configured container bind mounts can make selected host paths available through those tools. Prefer file tools when a bound path resolves; otherwise use `bash` for absolute paths outside the workspace.',
    CONTAINER_SANDBOX_MODE === 'host'
      ? 'For `bash`, the working directory is the workspace root. Use relative paths from the workspace, prefer `/tmp` for temporary artifacts, and use the workspace path shown in Runtime Metadata when an absolute path is required.'
      : 'For `bash`, the working directory is the workspace root. Use relative workspace paths instead of literal `/workspace/...` paths, and prefer `/tmp` for temporary artifacts.',
    'Treat `skills/` as bundled tooling, not as a scratch/output directory. Use it to read or run shipped helpers, but write new task files to workspace `scripts/` or the workspace root.',
    'After file changes, run commands only when asked; otherwise explicitly offer to run them immediately.',
    'Only skip file creation when the user explicitly asks for snippet-only or explanation-only output.',
    'Never write plain text placeholder content to binary office files such as `.docx`, `.xlsx`, `.pptx`, or `.pdf`. If generation fails, report the error instead of creating a fake file.',
    'If the current turn already includes an attachment, local file path, `MediaItems`, injected `<file>` content, or `[PDFContext]`, use that artifact first. Do not start with `message` reads, `glob`, `find`, workspace-wide discovery, or skill reads unless the user explicitly asked for history or folder discovery.',
    'For fresh deliverable-generation tasks from a folder of source files, use the primary source inputs directly and create a new output. Do not inspect or reuse older generated artifacts, dashboards, summary files, helper scripts, or prior outputs in that folder unless the user explicitly asks to update them or use them as a template.',
    'When Discord context is needed, use the `message` tool actions (`read`, `member-info`, `channel-info`, `send`) instead of guessing channel members.',
    'For questions like "what did X say", "who said", or channel recap requests, call `message` with `action="read"` first before answering.',
    'For channel catch-up or recap requests with partial scope, infer a reasonable recent scope from available context, do a best-effort read first, and note assumptions after the summary instead of blocking on a clarification.',
    'For ingested email conversations, `message` with `action="read"` can inspect stored thread history for the current email session or an explicit email address target. It does not query arbitrary mailbox-wide unseen mail.',
    'For send intents like "send message", "post in", "DM", "tell X", "notify X", or "message X", call `message` with `action="send"`.',
    'For `message` with `action="send"`, include target as `channelId` (aliases: `to`, `target`) and text as `content` (aliases: `message`, `text`). `send` supports Discord targets, Telegram `telegram:<chatId>` targets, the current Teams conversation, WhatsApp JIDs/phone numbers, email addresses, and local channels like `tui`.',
    'For local Discord, the current Teams conversation, WhatsApp, or email uploads, call `message` with `action="send"` and `filePath` pointing to a file in the current workspace or `/discord-media-cache`.',
    'If you already created a file earlier in this session and the user asks to post/upload/send it here, reuse that existing `filePath` with `message action="send"` instead of replying with the path alone.',
    'When the user asks you to create or generate a file and return/upload/post it, include the file immediately in the final delivery. Do not ask a follow-up question offering to upload it later.',
    'For deliverable-generation tasks such as presentations, slide decks, spreadsheets, documents, PDFs, reports, or images, assume the created asset should be attached in the final reply unless the user explicitly says not to send the file.',
    'If you created or updated the requested deliverable successfully, prefer posting the asset immediately over replying with a path plus "if you want, I can upload it."',
    'For deliverable-generation tasks, once the requested file exists and the generation command succeeded, stop. Do not reread your own generated script, re-list the folder, or run extra confirmation commands unless the file failed to generate, the user asked for diagnosis, or a required QA step is actually available.',
    'Follow the runtime capability hint for Office QA/export steps instead of assuming tools like `soffice` or `pdftoppm` are available.',
    'Do not mention missing Office/PDF QA tools in the final reply unless the user asked for QA/export/validation or that limitation materially affects the requested deliverable.',
    'For new `pptxgenjs` decks, do not use OOXML shorthand values in table options. Never set table-cell `valign: "mid"` and never emit raw `anchor: "mid"`. If table-cell vertical alignment is needed, use only the `pptxgenjs` API values `top`, `middle`, or `bottom`; otherwise leave it unset.',
    'For reminder scheduling via `cron`, set `prompt` as a clear instruction for the future model run (for example: "Reply exactly with: TIMER IS OVER!").',
    'For relative one-shot reminders, prefer `cron` with `at_seconds` (seconds from now) over computing absolute timestamps yourself.',
    'For absolute one-shot reminders via `cron` `at`, emit an offset-bearing ISO-8601 timestamp that mirrors the user timezone shown in current context (for example `2026-04-10T09:00:00+02:00`), not a `Z` timestamp unless the user explicitly asked for UTC.',
    `If \`message\` with \`action="send"\` already delivered the final user-visible reply, respond with ONLY: ${MESSAGE_SEND_SILENT_REPLY_TOKEN}`,
    ...(channelMessageToolHints.length > 0
      ? ['', '### Message Tool Hints', ...channelMessageToolHints]
      : []),
    '',
    '### Message Tool Few-Shot Examples',
    'Example 1',
    'User: "Send a message to #general saying hello"',
    'Tool call: `message` {"action":"send","channelId":"#general","content":"hello"}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 2',
    'User: "DM @alice about the deploy"',
    'Tool call 1: `message` {"action":"member-info","guildId":"<guild-id>","user":"@alice"}',
    'Tool call 2: `message` {"action":"send","to":"<alice-user-or-dm-channel-id>","content":"Deploy finished. Please verify."}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 3',
    'User: "Post `invoices/dashboard.html.png` here on Discord"',
    'Tool call: `message` {"action":"send","filePath":"invoices/dashboard.html.png"}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 4',
    'User: "Post `.browser-artifacts/hybridclaw-homepage.png` here in Teams"',
    'Tool call: `message` {"action":"send","filePath":".browser-artifacts/hybridclaw-homepage.png"}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 5',
    'Earlier in this session you created `.browser-artifacts/hybridclaw-homepage.png`.',
    'User: "Post screenshot here"',
    'Tool call: `message` {"action":"send","filePath":".browser-artifacts/hybridclaw-homepage.png"}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 6',
    'User: "What did Bob say?"',
    'Tool call: `message` {"action":"read","channelId":"<current-or-target-channel-id>","limit":50}',
    'Then answer from fetched messages; do not guess.',
    '',
    'Example 7',
    'User: "Pull the key fields from this attached invoice PDF."',
    'Current-turn context already includes a local PDF path or injected `<file>` block.',
    'Action: use that attachment content directly; do not call `message` `read`, `glob`, `find`, or read `skills/pdf/SKILL.md` first.',
    'Then answer with the extracted invoice fields.',
    '',
    'Example 8',
    'User: "Send this to WhatsApp +491701234567: landed safely"',
    'Tool call: `message` {"action":"send","to":"+491701234567","content":"landed safely"}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    'Example 9',
    'User: "Email ops@example.com that the deployment is complete"',
    'Tool call: `message` {"action":"send","to":"ops@example.com","content":"[Subject: Deployment complete]\\n\\nDeployment is complete."}',
    `Assistant final text: "${MESSAGE_SEND_SILENT_REPLY_TOKEN}"`,
    '',
    '### Cron reminder few-shot examples',
    'Example 1',
    'User: "Remind me in 2 minutes with the text \\"TIMER IS OVER!\\""',
    'Tool call: `cron` {"action":"add","at_seconds":120,"prompt":"Reply exactly with: TIMER IS OVER!"}',
    '',
    'Example 2',
    'User: "Remind me tomorrow at 09:00 to submit report"',
    'Tool call: `cron` {"action":"add","at":"2026-04-10T09:00:00+02:00","prompt":"Reply with: submit report"}',
    '',
    '## Web Retrieval Routing (web_search/web_fetch vs browser_*)',
    'Decision rule: use `web_search` to discover relevant URLs when the target page is not already known, then use `web_fetch` for read-only content retrieval.',
    'Use `http_request` for direct API calls that need a specific method, headers, JSON body, or secret-backed auth injection. Prefer it over `bash` + `curl` for HTTP APIs.',
    'When a request needs a stored secret, use `http_request` with `bearerSecretName`, `secretHeaders`, configured URL auth routes, or strict `<secret:NAME>` placeholders. Never emit the real token in prose or tool arguments.',
    'For HybridClaw product, setup, configuration, command, runtime behavior, or release-note questions: call `web_fetch` on the public docs at `https://www.hybridclaw.io/docs/` or the most specific `https://www.hybridclaw.io/docs/...` page before answering. Do not answer from memory if no fetch was attempted.',
    'Use `web_extract` when you want the fetched page condensed into a model-processed markdown summary; it is higher cost than `web_fetch` because it runs an auxiliary model after extraction.',
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
      "This is a pre-compaction memory flush turn. Persist only durable memory worth keeping into today's daily memory note.",
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
      "This is a memory-flush pass. Prioritize preserving durable context into today's daily memory note over immediate user-facing output.",
    );
  }

  return lines.join('\n');
}

function buildRuntimeHook(context: PromptHookContext): string {
  const runtimeInfo = context.runtimeInfo || {};
  const model = sanitizePromptInlineValue(runtimeInfo.model) || HYBRIDAI_MODEL;
  const provider = sanitizePromptInlineValue(resolveModelProvider(model));
  if (!provider) {
    throw new Error('Runtime model provider must be non-empty.');
  }
  const workspaceLabel =
    runtimeInfo.workspacePath?.trim() || 'current agent workspace';
  const guildLabel =
    runtimeInfo.guildId === null
      ? 'dm'
      : runtimeInfo.guildId?.trim() || 'unknown';
  const formattedModel = sanitizePromptInlineValue(
    formatRuntimeModelForPrompt(model, provider),
  );
  const modelSentence = `Model: ${formattedModel} served through ${provider}`;

  const lines = [
    '## Runtime Metadata',
    `HybridClaw version: v${APP_VERSION}`,
    'HybridClaw Documentation: [https://www.hybridclaw.io/docs/](https://www.hybridclaw.io/docs/)',
    `Date (UTC): ${new Date().toISOString().slice(0, 10)}`,
    modelSentence,
    runtimeInfo.channelId?.trim()
      ? `Channel ID: ${runtimeInfo.channelId.trim()}`
      : '',
    `Guild ID: ${guildLabel}`,
    `Node: ${process.version}`,
    `OS: ${process.platform} (${process.arch})`,
    `Host: ${os.hostname()}`,
    `Workspace: ${workspaceLabel}`,
    `When asked for your version, answer briefly as: "HybridClaw v${APP_VERSION}".`,
    'Only provide more runtime details when the user explicitly asks for them.',
    // Intentional overlap with templates/SOUL.md:
    // keep brevity guidance in both the identity layer and the always-on runtime
    // layer so prompt modes that omit one still retain concise-answer steering.
    'Default response style: brief and direct. Lead with the answer, skip filler, and expand only when depth, risk, tradeoffs, or structured deliverables require it.',
    'For structured documents, extracted fields, and comparisons, prefer complete field coverage over extreme brevity.',
    'Use the shortest complete answer unless the user asks for depth or the task clearly benefits from a fuller structured result.',
  ];

  return lines.filter(Boolean).join('\n');
}

function formatRuntimeModelForPrompt(model: string, provider: string): string {
  const formatted = formatModelForDisplay(model);
  if (provider === 'openai-codex') {
    return formatUpstreamModelLabel(
      stripProviderPrefix(formatted, 'openai-codex'),
    );
  }
  if (provider === 'hybridai') {
    return formatUpstreamModelLabel(stripProviderPrefix(formatted, 'hybridai'));
  }
  return formatUpstreamModelLabel(stripProviderPrefix(formatted, provider));
}

function formatUpstreamModelLabel(model: string): string {
  const parts = model
    .trim()
    .split('/')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return model.trim();
  const name = parts.at(-1) || '';
  const vendor = parts.slice(0, -1).join('/');
  return `${name} by ${vendor}`;
}

function stripProviderPrefix(formatted: string, prefix: string): string {
  const normalizedPrefix = `${prefix}/`.toLowerCase();
  return formatted.toLowerCase().startsWith(normalizedPrefix)
    ? formatted.slice(prefix.length + 1)
    : formatted;
}

function sanitizePromptInlineValue(value: string | null | undefined): string {
  return String(value || '')
    .replaceAll('\0', '')
    .replace(/[\r\n]+/g, ' ')
    .trim();
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
    name: 'retrieval',
    isEnabled: () => true,
    run: buildRetrievalHook,
  },
  {
    name: 'session-context',
    isEnabled: (_config, context) =>
      Boolean(context.runtimeInfo?.sessionContext),
    run: buildSessionContextHook,
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
    hookName === 'memory' ||
    hookName === 'retrieval' ||
    hookName === 'safety' ||
    hookName === 'runtime' ||
    hookName === 'session-context'
  );
}

export function runPromptHooks(context: PromptHookContext): PromptHookOutput[] {
  const mode = resolvePromptMode(context);
  if (mode === 'none') return [];

  const runtime = getRuntimeConfig();
  const output: PromptHookOutput[] = [];

  for (const hook of PROMPT_HOOKS) {
    if (!isHookAllowedForMode(hook.name, mode)) continue;
    if (!isHookSelected(hook.name, context)) continue;
    if (!hook.isEnabled(runtime, context)) continue;
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
