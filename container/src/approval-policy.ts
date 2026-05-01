import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { URL } from 'node:url';
import YAML from 'yaml';
import type {
  ClassifierMiddlewareSkill,
  MiddlewareDecision,
} from '../shared/middleware-contract.js';
import type {
  NetworkPolicyAction,
  NetworkRule,
} from '../shared/network-policy.js';
import {
  asRecord,
  DEFAULT_NETWORK_DEFAULT,
  DEFAULT_NETWORK_RULES,
  evaluateNetworkPolicyAccess,
  normalizeNetworkHostScope,
  normalizeNetworkPort,
  readNetworkPolicyState,
} from '../shared/network-policy.js';
import { classifyMcpTool } from './mcp/tool-classifier.js';
import { WORKSPACE_ROOT, WORKSPACE_ROOT_DISPLAY } from './runtime-paths.js';
import {
  createStakesClassifier,
  type StakesClassifier,
  type StakesLevel,
  type StakesScore,
} from './stakes-classifier.js';
import {
  createStakesMiddlewareSkill,
  type StakesMiddlewareContext,
  type StakesMiddlewareResult,
} from './stakes-middleware.js';
import { normalizeText } from './text-normalization.js';
import {
  type ChatMessage,
  type EscalationTarget,
  normalizeEscalationTarget,
} from './types.js';

export type {
  NetworkPolicyAction,
  NetworkRule,
} from '../shared/network-policy.js';
export {
  DEFAULT_NETWORK_DEFAULT,
  DEFAULT_NETWORK_RULES,
  normalizeNetworkRule,
} from '../shared/network-policy.js';
export type {
  StakesClassificationInput,
  StakesClassifier,
  StakesLevel,
  StakesScore,
  StakesSignal,
} from './stakes-classifier.js';

export type ApprovalTier = 'green' | 'yellow' | 'red';
export type AutonomyLevel =
  | 'full-autonomous'
  | 'low-stakes-autonomous'
  | 'confirm-each';
export type EscalationRoute =
  | 'none'
  | 'implicit_notice'
  | 'approval_request'
  | 'policy_denial';

export type ApprovalDecision =
  | 'auto'
  | 'implicit'
  | 'approved_once'
  | 'approved_session'
  | 'approved_agent'
  | 'approved_all'
  | 'approved_fullauto'
  | 'promoted'
  | 'required'
  | 'denied';

export interface ApprovalPolicyRule {
  pattern?: string;
  paths?: string[];
  tools?: string[];
}

export interface ApprovalPolicyConfig {
  pinnedRed: ApprovalPolicyRule[];
  autonomy: {
    defaultLevel: AutonomyLevel;
    tools: Record<string, AutonomyLevel>;
    actions: Record<string, AutonomyLevel>;
  };
  networkDefault: NetworkPolicyAction;
  networkRules: NetworkRule[];
  networkPresets: string[];
  workspaceFence: boolean;
  maxPendingApprovals: number;
  approvalTimeoutSecs: number;
  audit: {
    logAllRed: boolean;
    logDenials: boolean;
  };
}

interface ClassifiedAction {
  tier: ApprovalTier;
  actionKey: string;
  intent: string;
  consequenceIfDenied: string;
  reason: string;
  commandPreview: string;
  pathHints: string[];
  hostHints: string[];
  writeIntent: boolean;
  promotableRed: boolean;
  stickyYellow: boolean;
  hardDeny?: boolean;
}

interface PendingApproval {
  id: string;
  fingerprint: string;
  actionKey: string;
  toolName: string;
  intent: string;
  consequenceIfDenied: string;
  reason: string;
  commandPreview: string;
  createdAtMs: number;
  expiresAtMs: number;
  originalPrompt: string;
  pinned: boolean;
}

export interface ApprovalPrelude {
  immediateMessage?: string;
  replayPrompt?: string;
  approvalMode?: ApprovalMode;
  approvedRequestId?: string;
}

export interface ToolApprovalEvaluation {
  baseTier: ApprovalTier;
  tier: ApprovalTier;
  autonomyLevel: AutonomyLevel;
  stakes: StakesLevel;
  stakesScore: StakesScore;
  stakesMiddlewareDecision: StakesMiddlewareResult['decision'];
  escalationRoute: EscalationRoute;
  escalationTarget?: EscalationTarget;
  decision: ApprovalDecision;
  actionKey: string;
  fingerprint: string;
  requestId?: string;
  expiresAtMs?: number;
  intent: string;
  consequenceIfDenied: string;
  reason: string;
  commandPreview: string;
  pinned: boolean;
  implicitDelayMs?: number;
  hostHints: string[];
}

const WORKSPACE_ROOT_ACTUAL = WORKSPACE_ROOT;
const POLICY_PATH = path.join(
  WORKSPACE_ROOT_ACTUAL,
  '.hybridclaw',
  'policy.yaml',
);
const AGENT_TRUST_STORE_PATH = path.join(
  WORKSPACE_ROOT_ACTUAL,
  '.hybridclaw',
  'approval-agent-trust.json',
);
const APPROVAL_MODES = ['once', 'session', 'agent', 'all'] as const;
type ApprovalMode = (typeof APPROVAL_MODES)[number];
const TRUST_STORE_PATH = path.join(
  WORKSPACE_ROOT_ACTUAL,
  'approval-trust.json',
);
const LEGACY_AGENT_TRUST_STORE_PATH = path.join(
  WORKSPACE_ROOT_ACTUAL,
  '.hybridclaw',
  'approval-trust.json',
);
const AGENT_ID_ENV = 'HYBRIDCLAW_AGENT_ID';
const YELLOW_IMPLICIT_DELAY_MS = 5_000;
const YELLOW_IMPLICIT_DELAY_SECS = Math.max(
  1,
  Math.round(YELLOW_IMPLICIT_DELAY_MS / 1_000),
);
const IMPLICIT_DELAY_BROWSER_INPUT_TOOLS = new Set([
  'browser_press',
  'browser_type',
  'browser_secret_type',
  'browser_upload',
]);
const MAX_PROMPT_CHARS = 1_200;
const MAX_COMMAND_PREVIEW_CHARS = 160;
const SCRATCH_ROOTS = Array.from(
  new Set(
    ['/tmp', '/private/tmp', os.tmpdir()]
      .map((value) => value.trim())
      .filter(Boolean)
      .map((value) => path.resolve(value)),
  ),
);

export const DEFAULT_POLICY: ApprovalPolicyConfig = {
  pinnedRed: [
    { pattern: 'rm\\s+-rf\\s+/' },
    { paths: ['~/.ssh/**', '/etc/**', '.env*'] },
    { tools: ['force_push'] },
  ],
  autonomy: {
    defaultLevel: 'full-autonomous',
    tools: {},
    actions: {},
  },
  networkDefault: DEFAULT_NETWORK_DEFAULT,
  networkRules: DEFAULT_NETWORK_RULES,
  networkPresets: [],
  workspaceFence: true,
  maxPendingApprovals: 3,
  approvalTimeoutSecs: 120,
  audit: {
    logAllRed: true,
    logDenials: true,
  },
};

const CRITICAL_BASH_RE =
  /\b(sudo|mkfs(?:\.[a-z0-9_+-]+)?|shutdown|reboot|poweroff)\b|:\(\)\s*\{.*\};\s*:|\bchmod\s+777\b|\bcurl\b[^\n|]*\|\s*(sh|bash|zsh)\b|\bwget\b[^\n|]*\|\s*(sh|bash|zsh)\b/i;
const FORCE_PUSH_RE = /\bgit\s+push\s+--force(?:-with-lease)?\b/i;
const DELETE_RE = /\brm\s+-[^\n;|&]*\b|\bfind\b[^\n]*\s-delete\b/i;
const WRITE_INTENT_RE =
  /\b(mkdir|touch|mv|cp|chmod|chown|tee)\b|(^|[^>])>>?[^>]|sed\s+-i|perl\s+-pi/i;
const INSTALL_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:install|add)\b|\b(?:pip|pip3)\s+install\b|\bpython(?:3)?\s+-m\s+pip\s+install\b|\buv\s+pip\s+install\b/i;
const GIT_WRITE_RE =
  /\bgit\s+(add|commit|checkout\s+-b|branch|merge|rebase|tag)\b/i;
const UNKNOWN_SCRIPT_RE =
  /(^|\s)(\.[/\\][^\s]+|bash\s+[^\s]+\.sh|zsh\s+[^\s]+\.sh|sh\s+[^\s]+\.sh)(\s|$)/i;
const READ_ONLY_PDF_SCRIPT_RE =
  /^\s*node\s+skills\/pdf\/scripts\/(?:extract_pdf_text|check_fillable_fields|extract_form_field_info|extract_form_structure)\.mjs\b/i;
const READ_ONLY_BASH_RE =
  /^\s*(ls|pwd|cat|head|tail|wc|rg|grep|find|git\s+(status|log|diff|show)|npm\s+test|pnpm\s+test|yarn\s+test|vitest|pytest|phpunit|node\s+--version|npm\s+--version|pnpm\s+--version|yarn\s+--version)\b/i;
const NETWORK_COMMAND_RE = /\b(curl|wget|http|https|ssh|scp)\b/i;
const ABS_PATH_RE = /(^|\s)(\/[^\s"'`;,|&()<>]+)/g;
const URL_RE = /https?:\/\/[^\s"'`<>]+/gi;
const HOST_RE =
  /\b(?:ssh|scp)\s+[^\s@]*@?([a-zA-Z0-9.-]+\.[a-zA-Z]{2,})(?::\S+)?/g;
const APPROVE_RE =
  /^(?:\/?(?:approve|yes|y))(?:\s+([a-f0-9-]{6,64}))?(?:\s+(for\s+session|session|for\s+all|all|for\s+agent|agent))?$/i;
const DENY_RE = /^(?:\/?(?:deny|reject|skip|no|n))(?:\s+([a-f0-9-]{6,64}))?$/i;

function isVoiceChannelId(value: string | undefined): boolean {
  return String(value || '')
    .trim()
    .toLowerCase()
    .startsWith('voice:');
}

function normalizePrompt(value: string): string {
  return normalizeText(value).slice(0, MAX_PROMPT_CHARS);
}

function normalizePreview(value: string): string {
  const clean = normalizeText(value);
  if (!clean) return '(no command preview)';
  return clean.length > MAX_COMMAND_PREVIEW_CHARS
    ? `${clean.slice(0, MAX_COMMAND_PREVIEW_CHARS - 1)}...`
    : clean;
}

function stableHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function escalationRouteForDecision(
  decision: ApprovalDecision,
  tier: ApprovalTier,
): EscalationRoute {
  if (decision === 'denied') return 'policy_denial';
  if (decision === 'required') return 'approval_request';
  if (tier === 'yellow' && decision === 'implicit') return 'implicit_notice';
  return 'none';
}

function formatStakesReasoning(score: StakesScore): string {
  const reasons =
    score.reasons.length > 0
      ? score.reasons.join('; ')
      : 'no classifier reasons reported';
  return `${score.level} stakes via ${score.classifier} (score ${score.score}, confidence ${score.confidence}): ${reasons}`;
}

function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // ignore
  }
  return {};
}

function normalizeBooleanValue(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw !== 'string') return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  return fallback;
}

function normalizeIntegerValue(raw: unknown, fallback: number): number {
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.trunc(raw);
  }
  if (typeof raw !== 'string') return fallback;
  const parsed = Number.parseInt(raw.trim(), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeAutonomyLevel(raw: unknown): AutonomyLevel | null {
  const value = String(raw || '')
    .trim()
    .toLowerCase();
  if (
    value === 'full-autonomous' ||
    value === 'low-stakes-autonomous' ||
    value === 'confirm-each'
  ) {
    return value;
  }
  return null;
}

function normalizeAutonomyMap(raw: unknown): Record<string, AutonomyLevel> {
  const record = asRecord(raw);
  const out: Record<string, AutonomyLevel> = {};
  for (const [rawKey, rawValue] of Object.entries(record)) {
    const key = rawKey.trim().toLowerCase();
    const level = normalizeAutonomyLevel(rawValue);
    if (!key || !level) continue;
    out[key] = level;
  }
  return out;
}

function normalizeApprovalRule(raw: unknown): ApprovalPolicyRule | null {
  const rule = asRecord(raw);
  const pattern = String(rule.pattern || '').trim();
  const tools = normalizeStringList(rule.tools);
  const paths = normalizeStringList(rule.paths);
  if (!pattern && tools.length === 0 && paths.length === 0) {
    return null;
  }
  return {
    ...(pattern ? { pattern } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(paths.length > 0 ? { paths } : {}),
  };
}

function globPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function normalizePathValue(rawPath: string): string {
  const value = rawPath.trim().replace(/\\/g, '/');
  const withoutWorkspace = value.startsWith('/workspace/')
    ? value.slice('/workspace/'.length)
    : value;
  return withoutWorkspace.replace(/^\.\/+/, '').replace(/^\/+/, '');
}

function matchesPathPattern(candidatePath: string, pattern: string): boolean {
  const normalizedCandidate = normalizePathValue(candidatePath);
  const normalizedPattern = pattern.trim().replace(/\\/g, '/');
  if (!normalizedPattern) return false;

  // Relative patterns (e.g. ".env*") should match both root and any nested path.
  if (
    !normalizedPattern.startsWith('/') &&
    !normalizedPattern.startsWith('~/')
  ) {
    const relRe = globPatternToRegExp(normalizedPattern.replace(/^\.\//, ''));
    if (relRe.test(normalizedCandidate)) return true;
    const basename = path.posix.basename(normalizedCandidate);
    if (relRe.test(basename)) return true;
    return false;
  }

  const absoluteCandidate = candidatePath.trim().replace(/\\/g, '/');
  const absoluteRe = globPatternToRegExp(normalizedPattern);
  return absoluteRe.test(absoluteCandidate);
}

export function parsePolicyYaml(raw: string): Partial<ApprovalPolicyConfig> {
  const document = asRecord(YAML.parse(raw) as unknown);
  const approval = asRecord(document.approval);
  const autonomy = asRecord(document.autonomy);
  const audit = asRecord(document.audit);
  const pinnedRed = Array.isArray(approval.pinned_red)
    ? approval.pinned_red
        .map((rule) => normalizeApprovalRule(rule))
        .filter((rule): rule is ApprovalPolicyRule => Boolean(rule))
    : [];
  const networkState = readNetworkPolicyState(document);

  return {
    ...(pinnedRed.length > 0 ? { pinnedRed } : {}),
    autonomy: {
      defaultLevel:
        normalizeAutonomyLevel(autonomy.default) ||
        DEFAULT_POLICY.autonomy.defaultLevel,
      tools: normalizeAutonomyMap(autonomy.tools),
      actions: normalizeAutonomyMap(autonomy.actions),
    },
    networkDefault: networkState.defaultAction,
    networkRules: networkState.rules.map((rule) => ({
      ...rule,
      methods: [...rule.methods],
      paths: [...rule.paths],
    })),
    networkPresets: [...networkState.presets],
    workspaceFence: normalizeBooleanValue(
      approval.workspace_fence,
      DEFAULT_POLICY.workspaceFence,
    ),
    maxPendingApprovals: Math.max(
      1,
      normalizeIntegerValue(
        approval.max_pending_approvals,
        DEFAULT_POLICY.maxPendingApprovals,
      ),
    ),
    approvalTimeoutSecs: Math.max(
      5,
      normalizeIntegerValue(
        approval.approval_timeout_secs,
        DEFAULT_POLICY.approvalTimeoutSecs,
      ),
    ),
    audit: {
      logAllRed: normalizeBooleanValue(
        audit.log_all_red,
        DEFAULT_POLICY.audit.logAllRed,
      ),
      logDenials: normalizeBooleanValue(
        audit.log_denials,
        DEFAULT_POLICY.audit.logDenials,
      ),
    },
  };
}

export function loadPolicyFromDisk(policyPath: string): ApprovalPolicyConfig {
  let filePolicy: Partial<ApprovalPolicyConfig> = {};
  try {
    if (fs.existsSync(policyPath)) {
      const raw = fs.readFileSync(policyPath, 'utf-8');
      filePolicy = parsePolicyYaml(raw);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[approval-policy] failed to load policy from ${policyPath}: ${message}`,
    );
    filePolicy = {};
  }

  return {
    pinnedRed:
      Array.isArray(filePolicy.pinnedRed) && filePolicy.pinnedRed.length > 0
        ? filePolicy.pinnedRed
        : DEFAULT_POLICY.pinnedRed,
    autonomy: {
      defaultLevel:
        normalizeAutonomyLevel(filePolicy.autonomy?.defaultLevel) ||
        DEFAULT_POLICY.autonomy.defaultLevel,
      tools:
        filePolicy.autonomy?.tools &&
        typeof filePolicy.autonomy.tools === 'object'
          ? { ...filePolicy.autonomy.tools }
          : {},
      actions:
        filePolicy.autonomy?.actions &&
        typeof filePolicy.autonomy.actions === 'object'
          ? { ...filePolicy.autonomy.actions }
          : {},
    },
    networkDefault:
      filePolicy.networkDefault === 'allow' ||
      filePolicy.networkDefault === 'deny'
        ? filePolicy.networkDefault
        : DEFAULT_POLICY.networkDefault,
    networkRules: Array.isArray(filePolicy.networkRules)
      ? filePolicy.networkRules.map((rule) => ({
          ...rule,
          methods: [...rule.methods],
          paths: [...rule.paths],
        }))
      : DEFAULT_POLICY.networkRules.map((rule) => ({
          ...rule,
          methods: [...rule.methods],
          paths: [...rule.paths],
        })),
    networkPresets: Array.isArray(filePolicy.networkPresets)
      ? [...filePolicy.networkPresets]
      : [],
    workspaceFence:
      typeof filePolicy.workspaceFence === 'boolean'
        ? filePolicy.workspaceFence
        : DEFAULT_POLICY.workspaceFence,
    maxPendingApprovals:
      typeof filePolicy.maxPendingApprovals === 'number'
        ? Math.max(1, filePolicy.maxPendingApprovals)
        : DEFAULT_POLICY.maxPendingApprovals,
    approvalTimeoutSecs:
      typeof filePolicy.approvalTimeoutSecs === 'number'
        ? Math.max(5, filePolicy.approvalTimeoutSecs)
        : DEFAULT_POLICY.approvalTimeoutSecs,
    audit: {
      logAllRed:
        typeof filePolicy.audit?.logAllRed === 'boolean'
          ? filePolicy.audit.logAllRed
          : DEFAULT_POLICY.audit.logAllRed,
      logDenials:
        typeof filePolicy.audit?.logDenials === 'boolean'
          ? filePolicy.audit.logDenials
          : DEFAULT_POLICY.audit.logDenials,
    },
  };
}

function latestUserMessageText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role !== 'user') continue;
    const content = messages[i].content;
    if (typeof content === 'string')
      return content.trim().slice(0, MAX_PROMPT_CHARS);
    if (!Array.isArray(content)) continue;
    const textParts: string[] = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      if (part.type !== 'text') continue;
      if (typeof part.text !== 'string') continue;
      const trimmed = part.text.trim();
      if (trimmed) textParts.push(trimmed);
    }
    if (textParts.length > 0) {
      return textParts.join('\n').trim().slice(0, MAX_PROMPT_CHARS);
    }
  }
  return '';
}

function extractHostsFromUrlLikeText(input: string): string[] {
  const hosts = new Set<string>();
  for (const match of input.matchAll(URL_RE)) {
    const raw = match[0];
    try {
      const parsed = new URL(raw);
      if (parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
    } catch {
      // ignore
    }
  }
  for (const match of input.matchAll(HOST_RE)) {
    const host = String(match[1] || '')
      .trim()
      .toLowerCase();
    if (host) hosts.add(host);
  }
  return [...hosts];
}

export function normalizeHostScope(host: string): string {
  return normalizeNetworkHostScope(host);
}

function defaultPortForProtocol(protocol: string): number {
  const normalized = protocol.trim().toLowerCase();
  if (normalized === 'http:') return 80;
  if (normalized === 'https:') return 443;
  return 443;
}

function parseUrlNetworkTarget(rawUrl: string): {
  host: string;
  port: number;
  path: string;
} | null {
  try {
    const parsed = new URL(rawUrl);
    const host = parsed.hostname.trim().toLowerCase();
    if (!host) return null;
    const pathValue = parsed.pathname || '/';
    const explicitPort = parsed.port ? normalizeNetworkPort(parsed.port) : null;
    return {
      host,
      port:
        explicitPort && explicitPort !== '*'
          ? explicitPort
          : defaultPortForProtocol(parsed.protocol),
      path: pathValue || '/',
    };
  } catch {
    return null;
  }
}

function inferBashHttpMethod(command: string): string {
  const explicit = command.match(/\b(?:-X|--request)\s+([A-Za-z]+)/i);
  if (explicit?.[1]) return explicit[1].toUpperCase();
  if (/\b(?:--data(?:-raw|-binary)?|-d|--form|-F)\b/i.test(command)) {
    return 'POST';
  }
  if (/\bwget\b/i.test(command)) return 'GET';
  return 'GET';
}

function extractAbsolutePaths(input: string): string[] {
  const paths = new Set<string>();
  for (const match of input.matchAll(ABS_PATH_RE)) {
    const candidate = String(match[2] || '').trim();
    if (!candidate || candidate === '/' || candidate === '//') continue;
    paths.add(path.resolve(candidate));
  }
  return [...paths];
}

function stripHereDocBodies(command: string): string {
  const lines = command.split(/\r?\n/);
  const kept: string[] = [];
  let delimiter: string | null = null;

  for (const line of lines) {
    if (delimiter) {
      if (line.trim() === delimiter) {
        delimiter = null;
      }
      continue;
    }

    kept.push(line);
    const match = line.match(
      /<<-?\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/,
    );
    delimiter = match?.[1] || match?.[2] || match?.[3] || null;
  }

  return kept.join('\n');
}

function tokenizeShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < segment.length; index += 1) {
    const char = segment[index];
    if (quote) {
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === '\\' && quote === '"' && index + 1 < segment.length) {
        current += segment[index + 1];
        index += 1;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current) tokens.push(current);
  return tokens;
}

function sanitizeInterpreterInlineScripts(segment: string): string {
  const tokens = tokenizeShellSegment(segment);
  if (tokens.length === 0) return segment.trim();

  const executable = path.posix.basename(tokens[0].trim().toLowerCase());
  let inlineFlags: Set<string> | null = null;
  if (executable === 'node' || executable === 'nodejs') {
    inlineFlags = new Set(['-e', '--eval', '-p', '--print']);
  } else if (/^python(?:\d+(?:\.\d+)*)?$/.test(executable)) {
    inlineFlags = new Set(['-c']);
  } else if (executable === 'perl' || executable === 'ruby') {
    inlineFlags = new Set(['-e']);
  } else if (executable === 'php') {
    inlineFlags = new Set(['-r']);
  }

  if (!inlineFlags) return segment.trim();

  const sanitized: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const normalized = token.trim().toLowerCase();
    sanitized.push(token);
    if (!inlineFlags.has(normalized)) continue;
    if (index + 1 >= tokens.length) continue;
    sanitized.push('__INLINE_SCRIPT__');
    index += 1;
  }
  return sanitized.join(' ');
}

function buildBashInspectionSurface(command: string): string {
  const stripped = stripHereDocBodies(command);
  return splitCommandSegments(stripped)
    .map((segment) => sanitizeInterpreterInlineScripts(segment))
    .join(' ; ');
}

function splitCommandSegments(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];

    if (char === "'" && quote !== '"') {
      quote = quote === "'" ? null : "'";
      current += char;
      continue;
    }
    if (char === '"' && quote !== "'") {
      quote = quote === '"' ? null : '"';
      current += char;
      continue;
    }

    if (!quote) {
      if (char === ';') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
      if ((char === '&' || char === '|') && next === char) {
        if (current.trim()) segments.push(current.trim());
        current = '';
        index += 1;
        continue;
      }
      if (char === '|') {
        if (current.trim()) segments.push(current.trim());
        current = '';
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) segments.push(current.trim());
  return segments;
}

function unquotePathToken(rawValue: string): string {
  const trimmed = rawValue.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function pushAbsolutePath(
  output: Set<string>,
  rawValue: string | undefined,
): void {
  const candidate = unquotePathToken(String(rawValue || ''));
  if (!candidate.startsWith('/')) return;
  output.add(candidate);
}

function extractLikelyWritePaths(command: string): string[] {
  const paths = new Set<string>();
  const segments = splitCommandSegments(command);

  for (const segment of segments) {
    const segmentAbsPaths = extractAbsolutePaths(segment);
    for (const match of segment.matchAll(
      /(?:^|\s)(?:--out|-o)\s+("[^"]+"|'[^']+'|\/[^\s"'`;,|&()<>]+)/g,
    )) {
      pushAbsolutePath(paths, match[1]);
    }
    for (const match of segment.matchAll(
      /(?:^|[^>])>>?\s*("[^"]+"|'[^']+'|\/[^\s"'`;,|&()<>]+)/g,
    )) {
      pushAbsolutePath(paths, match[1]);
    }
    for (const match of segment.matchAll(
      /(?:^|\s)tee(?:\s+-a)?\s+("[^"]+"|'[^']+'|\/[^\s"'`;,|&()<>]+)/g,
    )) {
      pushAbsolutePath(paths, match[1]);
    }

    if (/^\s*(mkdir|touch|chmod|chown)\b/i.test(segment)) {
      for (const candidate of segmentAbsPaths) {
        paths.add(candidate);
      }
    }

    if (/^\s*(cp|mv)\b/i.test(segment)) {
      const destination = segmentAbsPaths.at(-1);
      if (destination) paths.add(destination);
    }
  }

  return [...paths];
}

function isWithinResolvedRoot(candidate: string, root: string): boolean {
  const resolvedCandidate = path.resolve(candidate);
  const resolvedRoot = path.resolve(root);
  return (
    resolvedCandidate === resolvedRoot ||
    resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

function isWorkspacePath(rawPath: string): boolean {
  return (
    isWithinResolvedRoot(rawPath, WORKSPACE_ROOT_DISPLAY) ||
    isWithinResolvedRoot(rawPath, WORKSPACE_ROOT_ACTUAL)
  );
}

function isScratchPath(rawPath: string): boolean {
  return SCRATCH_ROOTS.some((root) => isWithinResolvedRoot(rawPath, root));
}

function primaryPathKey(rawPath: string): string {
  const normalized = normalizePathValue(rawPath);
  if (!normalized) return 'root';
  const [first] = normalized.split('/');
  return first || 'root';
}

function parseModeFromApproveMatch(
  match: RegExpMatchArray | null,
): ApprovalMode {
  const scope = String(match?.[2] || '').toLowerCase();
  if (scope.includes('all')) return 'all';
  if (scope.includes('agent')) return 'agent';
  if (scope.includes('session')) return 'session';
  return 'once';
}

function parseApprovalDirective(input: string): {
  kind: 'approve' | 'deny';
  mode?: ApprovalMode;
  requestId: string;
} | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const directiveCandidates = [
    normalized,
    normalized.replace(/^(?:<@!?\d+>\s*)+/, ''),
  ];

  for (const candidate of directiveCandidates) {
    if (!candidate) continue;
    const approveMatch = candidate.match(APPROVE_RE);
    if (approveMatch) {
      return {
        kind: 'approve',
        mode: parseModeFromApproveMatch(approveMatch),
        requestId: String(approveMatch[1] || '').trim(),
      };
    }

    const denyMatch = candidate.match(DENY_RE);
    if (denyMatch) {
      return {
        kind: 'deny',
        requestId: String(denyMatch[1] || '').trim(),
      };
    }
  }

  return null;
}

function parseApprovalUserResponse(input: string): {
  kind: 'approve' | 'deny';
  mode?: ApprovalMode;
  requestId: string;
} | null {
  const normalized = input.trim();
  if (!normalized) return null;

  const candidates: string[] = [];
  const pushCandidate = (value: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (candidates.includes(trimmed)) return;
    candidates.push(trimmed);
  };

  pushCandidate(normalized);
  pushCandidate(normalized.replace(/^(?:<@!?\d+>\s*)+/, ''));

  const batchTailMatch = normalized.match(/Message\s+\d+\s*:\s*([\s\S]+)$/i);
  if (batchTailMatch?.[1]) {
    pushCandidate(batchTailMatch[1]);
  }

  const lines = normalized
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length > 0) {
    pushCandidate(lines[lines.length - 1]);
  }

  for (const candidate of candidates) {
    const parsed = parseApprovalDirective(candidate);
    if (parsed) return parsed;
  }
  return null;
}

interface PersistedApprovalTrustStore {
  version: 2;
  allowlistedActions: string[];
  allowlistedFingerprints: string[];
  updatedAt: string;
}

function parsePersistedTrustStore(
  raw: string,
): PersistedApprovalTrustStore | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return null;
    const record = parsed as Record<string, unknown>;
    const allowlistedActions = Array.isArray(record.allowlistedActions)
      ? record.allowlistedActions
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      : Array.isArray(record.trustedActions)
        ? record.trustedActions
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        : [];
    const allowlistedFingerprints = Array.isArray(
      record.allowlistedFingerprints,
    )
      ? record.allowlistedFingerprints
          .map((value) => String(value || '').trim())
          .filter(Boolean)
      : Array.isArray(record.trustedFingerprints)
        ? record.trustedFingerprints
            .map((value) => String(value || '').trim())
            .filter(Boolean)
        : [];
    return {
      version: 2,
      allowlistedActions,
      allowlistedFingerprints,
      updatedAt:
        typeof record.updatedAt === 'string'
          ? record.updatedAt
          : new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

function isPromiseLike<T>(
  value: T | Promise<T> | null | undefined,
): value is Promise<T> {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function',
  );
}

function normalizeStakesMiddlewareDecision(
  decision: MiddlewareDecision | null | undefined,
): MiddlewareDecision {
  return decision ?? { action: 'allow' };
}

export class TrustedAgentApprovalRuntime {
  private readonly policyPath: string;
  private readonly agentTrustStorePath: string;
  private readonly legacyAgentTrustStorePath: string;
  private readonly trustStorePath: string;
  private loadedPolicy: ApprovalPolicyConfig = DEFAULT_POLICY;
  private policyMtimeMs = -1;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly actionExecutionCounts = new Map<string, number>();
  private readonly explicitApprovalCounts = new Map<string, number>();
  private readonly oneShotFingerprints = new Set<string>();
  private readonly sessionTrustedActions = new Set<string>();
  private readonly agentTrustedActions = new Set<string>();
  private readonly agentTrustedFingerprints = new Set<string>();
  private readonly allowlistedActions = new Set<string>();
  private readonly allowlistedFingerprints = new Set<string>();
  private readonly seenNetworkHosts = new Set<string>();
  private readonly invalidPinnedRedPatternWarnings = new Set<string>();
  private readonly stakesClassifier: StakesClassifier;
  private readonly stakesMiddleware: ClassifierMiddlewareSkill<StakesMiddlewareContext>;
  private fullAutoEnabled = false;
  private readonly fullAutoNeverApprove = new Set<string>();

  constructor(
    policyPath = POLICY_PATH,
    agentTrustStorePath = AGENT_TRUST_STORE_PATH,
    trustStorePath = TRUST_STORE_PATH,
    legacyAgentTrustStorePath = LEGACY_AGENT_TRUST_STORE_PATH,
    stakesClassifier: StakesClassifier = createStakesClassifier(),
  ) {
    this.policyPath = policyPath;
    this.agentTrustStorePath = agentTrustStorePath;
    this.trustStorePath = trustStorePath;
    this.legacyAgentTrustStorePath = legacyAgentTrustStorePath;
    this.stakesClassifier = stakesClassifier;
    this.stakesMiddleware = createStakesMiddlewareSkill(this.stakesClassifier);
    this.reloadPolicyIfNeeded(true);
    this.loadPersistedTrustStore({
      trustStorePath: this.agentTrustStorePath,
      legacyTrustStorePath: this.legacyAgentTrustStorePath,
      actionSet: this.agentTrustedActions,
      fingerprintSet: this.agentTrustedFingerprints,
    });
    this.loadPersistedTrustStore({
      trustStorePath: this.trustStorePath,
      actionSet: this.allowlistedActions,
      fingerprintSet: this.allowlistedFingerprints,
    });
  }

  private runStakesMiddleware(
    context: Omit<StakesMiddlewareContext, 'recordStakesScore'>,
  ): StakesMiddlewareResult {
    const handler = this.stakesMiddleware.pre_send;
    if (!handler) {
      throw new Error('Stakes middleware is missing pre_send handler.');
    }
    let stakesScore: StakesScore | null = null;
    const decision = handler({
      ...context,
      recordStakesScore(score) {
        stakesScore = score;
      },
    });
    if (isPromiseLike(decision)) {
      throw new Error('Stakes middleware must be synchronous.');
    }
    if (!stakesScore) {
      throw new Error('Stakes middleware did not record a stakes score.');
    }
    return {
      decision: normalizeStakesMiddlewareDecision(decision),
      stakesScore,
    };
  }

  setFullAutoOptions(params?: {
    enabled?: boolean;
    neverApproveTools?: string[];
  }): void {
    this.fullAutoEnabled = params?.enabled === true;
    this.fullAutoNeverApprove.clear();
    for (const raw of params?.neverApproveTools || []) {
      const value = String(raw || '')
        .trim()
        .toLowerCase();
      if (!value) continue;
      this.fullAutoNeverApprove.add(value);
    }
  }

  private shouldNeverAutoApprove(toolName: string, actionKey: string): boolean {
    if (this.fullAutoNeverApprove.size === 0) return false;
    const normalizedTool = toolName.trim().toLowerCase();
    const normalizedAction = actionKey.trim().toLowerCase();
    return (
      this.fullAutoNeverApprove.has(normalizedTool) ||
      this.fullAutoNeverApprove.has(normalizedAction)
    );
  }

  private getCurrentAgentId(): string {
    return String(process.env[AGENT_ID_ENV] || '')
      .trim()
      .toLowerCase();
  }

  private evaluateNetworkAccess(params: {
    host: string;
    port: number;
    method: string;
    path: string;
    agentId?: string;
  }): { decision: NetworkPolicyAction | 'prompt'; matchedRule?: NetworkRule } {
    return evaluateNetworkPolicyAccess({
      rules: this.loadedPolicy.networkRules,
      defaultAction: this.loadedPolicy.networkDefault,
      host: params.host,
      port: params.port,
      method: params.method,
      path: params.path,
      agentId: params.agentId || this.getCurrentAgentId(),
    });
  }

  reloadPolicyIfNeeded(force = false): ApprovalPolicyConfig {
    let mtimeMs = -1;
    try {
      if (fs.existsSync(this.policyPath)) {
        mtimeMs = fs.statSync(this.policyPath).mtimeMs;
      }
    } catch {
      mtimeMs = -1;
    }
    if (force || mtimeMs !== this.policyMtimeMs) {
      this.loadedPolicy = loadPolicyFromDisk(this.policyPath);
      this.policyMtimeMs = mtimeMs;
    }
    return this.loadedPolicy;
  }

  private loadPersistedTrustStore(params: {
    trustStorePath: string;
    actionSet: Set<string>;
    fingerprintSet: Set<string>;
    legacyTrustStorePath?: string;
  }): void {
    params.actionSet.clear();
    params.fingerprintSet.clear();
    try {
      const sourcePath = fs.existsSync(params.trustStorePath)
        ? params.trustStorePath
        : params.legacyTrustStorePath;
      if (!sourcePath || !fs.existsSync(sourcePath)) return;
      const raw = fs.readFileSync(sourcePath, 'utf-8');
      const parsed = parsePersistedTrustStore(raw);
      if (!parsed) return;
      for (const actionKey of parsed.allowlistedActions) {
        params.actionSet.add(actionKey);
      }
      for (const fingerprint of parsed.allowlistedFingerprints) {
        params.fingerprintSet.add(fingerprint);
      }
      if (
        params.legacyTrustStorePath &&
        sourcePath === params.legacyTrustStorePath
      ) {
        this.persistPersistedTrustStore({
          trustStorePath: params.trustStorePath,
          actionSet: params.actionSet,
          fingerprintSet: params.fingerprintSet,
        });
      }
    } catch {
      // ignore malformed trust state; session trust still applies
    }
  }

  private persistPersistedTrustStore(params: {
    trustStorePath: string;
    actionSet: ReadonlySet<string>;
    fingerprintSet: ReadonlySet<string>;
  }): void {
    const payload: PersistedApprovalTrustStore = {
      version: 2,
      allowlistedActions: [...params.actionSet].sort(),
      allowlistedFingerprints: [...params.fingerprintSet].sort(),
      updatedAt: new Date().toISOString(),
    };
    try {
      const dir = path.dirname(params.trustStorePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmpPath = `${params.trustStorePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tmpPath, params.trustStorePath);
    } catch {
      // ignore persistence failures and continue with in-memory trust
    }
  }

  handleApprovalResponse(messages: ChatMessage[]): ApprovalPrelude | null {
    this.reloadPolicyIfNeeded();
    this.cleanupExpiredPending();
    if (this.pending.size === 0) return null;

    const latest = latestUserMessageText(messages);
    if (!latest) return null;

    const parsedResponse = parseApprovalUserResponse(latest);
    if (!parsedResponse) return null;

    const target = this.resolvePendingTarget(parsedResponse.requestId);
    if (!target) {
      return {
        immediateMessage: `No pending approval found for id "${parsedResponse.requestId}".`,
      };
    }

    if (parsedResponse.kind === 'deny') {
      this.pending.delete(target.id);
      return {
        immediateMessage: `Skipped \`${target.intent}\`. I will continue without that action.`,
      };
    }

    const requestedMode = parsedResponse.mode || 'once';
    let mode: ApprovalMode = requestedMode;
    this.pending.delete(target.id);
    if (requestedMode === 'session') {
      if (target.pinned) {
        // Pinned-red actions are never session-trusted. Approve only this single run.
        this.oneShotFingerprints.add(target.fingerprint);
        mode = 'once';
      } else {
        this.sessionTrustedActions.add(target.actionKey);
        this.sessionTrustedActions.add(target.fingerprint);
      }
    } else if (requestedMode === 'agent') {
      if (target.pinned) {
        // Pinned-red actions are never promoted to durable trust.
        this.oneShotFingerprints.add(target.fingerprint);
        mode = 'once';
      } else {
        this.agentTrustedActions.add(target.actionKey);
        this.agentTrustedFingerprints.add(target.fingerprint);
        this.persistPersistedTrustStore({
          trustStorePath: this.agentTrustStorePath,
          actionSet: this.agentTrustedActions,
          fingerprintSet: this.agentTrustedFingerprints,
        });
      }
    } else if (requestedMode === 'all') {
      if (target.pinned) {
        // Pinned-red actions are never promoted to durable trust.
        this.oneShotFingerprints.add(target.fingerprint);
        mode = 'once';
      } else {
        this.allowlistedActions.add(target.actionKey);
        this.allowlistedFingerprints.add(target.fingerprint);
        this.persistPersistedTrustStore({
          trustStorePath: this.trustStorePath,
          actionSet: this.allowlistedActions,
          fingerprintSet: this.allowlistedFingerprints,
        });
      }
    } else {
      this.oneShotFingerprints.add(target.fingerprint);
    }
    this.bumpCount(this.explicitApprovalCounts, target.actionKey);

    const modeSummary =
      mode === 'session'
        ? 'session trust'
        : mode === 'agent'
          ? 'agent trust'
          : mode === 'all'
            ? 'allowlisted for all'
            : 'once';
    const replayPrompt = normalizePrompt(
      [
        '[Approval already granted]',
        `The action "${target.intent}" is approved (${modeSummary}). Continue with it now.`,
        'Do not ask for approval again unless a new blocked action appears.',
        '',
        `Original user request: ${target.originalPrompt}`,
      ].join('\n'),
    );
    return {
      replayPrompt: replayPrompt || undefined,
      approvalMode: mode,
      approvedRequestId: target.id,
      immediateMessage: replayPrompt
        ? undefined
        : `Approved \`${target.intent}\` (${modeSummary}).`,
    };
  }

  evaluateToolCall(params: {
    toolName: string;
    argsJson: string;
    latestUserPrompt: string;
    channelId?: string;
    escalationTarget?: EscalationTarget;
  }): ToolApprovalEvaluation {
    this.reloadPolicyIfNeeded();
    this.cleanupExpiredPending();
    const args = parseJsonObject(params.argsJson);
    const classified = this.classifyAction(params.toolName, args);

    const fingerprint = stableHash(
      [
        params.toolName,
        classified.actionKey,
        normalizePreview(classified.commandPreview),
        normalizeText(JSON.stringify(args)),
      ].join('|'),
    );

    const pinnedByPolicy = this.isPinnedRed({
      toolName: params.toolName,
      preview: classified.commandPreview,
      pathHints: classified.pathHints,
      args,
    });
    const autonomyLevel = this.resolveAutonomyLevel({
      toolName: params.toolName,
      actionKey: classified.actionKey,
    });
    const safetyTier: ApprovalTier =
      pinnedByPolicy || classified.tier === 'red' ? 'red' : classified.tier;
    const stakesMiddleware = this.runStakesMiddleware({
      toolName: params.toolName,
      args,
      actionKey: classified.actionKey,
      intent: classified.intent,
      reason: classified.reason,
      target: classified.commandPreview,
      approvalTier: safetyTier,
      pathHints: classified.pathHints,
      hostHints: classified.hostHints,
      writeIntent: classified.writeIntent,
      pinned: pinnedByPolicy,
    });
    const stakesScore = stakesMiddleware.stakesScore;
    const stakes = stakesScore.level;
    const escalationTarget = normalizeEscalationTarget(params.escalationTarget);

    let baseTier: ApprovalTier = safetyTier;
    let outOfBoundByAutonomy = false;
    if (autonomyLevel === 'confirm-each') {
      outOfBoundByAutonomy = true;
      baseTier = 'red';
    } else if (autonomyLevel === 'low-stakes-autonomous') {
      // Low-stakes autonomy permits only low-stakes actions to proceed without
      // escalation. Medium and high stakes are out-of-bound and require a
      // paused explicit approval path, rather than a yellow implicit notice.
      if (stakes !== 'low') {
        outOfBoundByAutonomy = true;
        baseTier = 'red';
      }
    }

    let tier: ApprovalTier = baseTier;
    let decision: ApprovalDecision = 'auto';

    if (baseTier === 'red') {
      if (classified.hardDeny) {
        return {
          baseTier,
          tier: 'red',
          autonomyLevel,
          stakes,
          stakesScore,
          stakesMiddlewareDecision: stakesMiddleware.decision,
          escalationRoute: 'policy_denial',
          ...(escalationTarget ? { escalationTarget } : {}),
          decision: 'denied',
          actionKey: classified.actionKey,
          fingerprint,
          intent: classified.intent,
          consequenceIfDenied: classified.consequenceIfDenied,
          reason: classified.reason,
          commandPreview: classified.commandPreview,
          pinned: pinnedByPolicy,
          hostHints: classified.hostHints,
        };
      }

      const oneShotApproved = this.oneShotFingerprints.has(fingerprint);
      const sessionApproved =
        !pinnedByPolicy &&
        (this.sessionTrustedActions.has(classified.actionKey) ||
          this.sessionTrustedActions.has(fingerprint));
      const agentApproved =
        !pinnedByPolicy &&
        (this.agentTrustedActions.has(classified.actionKey) ||
          this.agentTrustedFingerprints.has(fingerprint));
      const allowlisted =
        !pinnedByPolicy &&
        (this.allowlistedActions.has(classified.actionKey) ||
          this.allowlistedFingerprints.has(fingerprint));
      const promotable =
        !pinnedByPolicy &&
        classified.promotableRed &&
        (this.explicitApprovalCounts.get(classified.actionKey) || 0) > 0;

      if (oneShotApproved) {
        this.oneShotFingerprints.delete(fingerprint);
        tier = pinnedByPolicy ? 'red' : 'yellow';
        decision = 'approved_once';
      } else if (sessionApproved) {
        tier = 'yellow';
        decision = 'approved_session';
      } else if (agentApproved) {
        tier = 'yellow';
        decision = 'approved_agent';
      } else if (allowlisted) {
        tier = 'yellow';
        decision = 'approved_all';
      } else if (promotable) {
        tier = 'yellow';
        decision = 'promoted';
      } else if (
        this.fullAutoEnabled &&
        !outOfBoundByAutonomy &&
        !this.shouldNeverAutoApprove(params.toolName, classified.actionKey)
      ) {
        tier = 'yellow';
        decision = 'approved_fullauto';
      } else {
        if (this.pending.size >= this.loadedPolicy.maxPendingApprovals) {
          return {
            baseTier,
            tier: 'red',
            autonomyLevel,
            stakes,
            stakesScore,
            stakesMiddlewareDecision: stakesMiddleware.decision,
            escalationRoute: 'policy_denial',
            ...(escalationTarget ? { escalationTarget } : {}),
            decision: 'denied',
            actionKey: classified.actionKey,
            fingerprint,
            intent: classified.intent,
            consequenceIfDenied:
              'If this is denied, I will continue with non-destructive alternatives only.',
            reason: `Approval queue is full (${this.loadedPolicy.maxPendingApprovals} pending).`,
            commandPreview: classified.commandPreview,
            pinned: pinnedByPolicy,
            hostHints: classified.hostHints,
          };
        }
        const request = this.getOrCreatePending({
          fingerprint,
          actionKey: classified.actionKey,
          toolName: params.toolName,
          intent: classified.intent,
          consequenceIfDenied: classified.consequenceIfDenied,
          reason: classified.reason,
          commandPreview: classified.commandPreview,
          originalPrompt: params.latestUserPrompt,
          pinned: pinnedByPolicy,
        });
        return {
          baseTier,
          tier: 'red',
          autonomyLevel,
          stakes,
          stakesScore,
          stakesMiddlewareDecision: stakesMiddleware.decision,
          escalationRoute: 'approval_request',
          ...(escalationTarget ? { escalationTarget } : {}),
          decision: 'required',
          actionKey: classified.actionKey,
          fingerprint,
          requestId: request.id,
          expiresAtMs: request.expiresAtMs,
          intent: classified.intent,
          consequenceIfDenied: classified.consequenceIfDenied,
          reason: classified.reason,
          commandPreview: classified.commandPreview,
          pinned: pinnedByPolicy,
          hostHints: classified.hostHints,
        };
      }
    }

    if (
      tier === 'yellow' &&
      decision === 'auto' &&
      this.fullAutoEnabled &&
      !outOfBoundByAutonomy &&
      !this.shouldNeverAutoApprove(params.toolName, classified.actionKey)
    ) {
      decision = 'approved_fullauto';
    }

    if (tier === 'yellow') {
      const executions =
        this.actionExecutionCounts.get(classified.actionKey) || 0;
      if (!classified.stickyYellow && executions >= 1) {
        tier = 'green';
        if (decision === 'auto') decision = 'promoted';
      } else if (decision === 'auto') {
        decision = 'implicit';
      }
    }

    if (tier === 'green' && decision === 'auto') {
      decision = 'auto';
    }

    return {
      baseTier,
      tier,
      autonomyLevel,
      stakes,
      stakesScore,
      stakesMiddlewareDecision: stakesMiddleware.decision,
      escalationRoute: escalationRouteForDecision(decision, tier),
      ...(escalationTarget ? { escalationTarget } : {}),
      decision,
      actionKey: classified.actionKey,
      fingerprint,
      intent: classified.intent,
      consequenceIfDenied: classified.consequenceIfDenied,
      reason: classified.reason,
      commandPreview: classified.commandPreview,
      pinned: pinnedByPolicy,
      implicitDelayMs:
        tier === 'yellow' &&
        decision === 'implicit' &&
        this.shouldApplyImplicitDelay(params.toolName, params.channelId)
          ? YELLOW_IMPLICIT_DELAY_MS
          : undefined,
      hostHints: classified.hostHints,
    };
  }

  afterToolExecution(
    evaluation: ToolApprovalEvaluation,
    succeeded: boolean,
  ): void {
    if (!succeeded) return;
    this.bumpCount(this.actionExecutionCounts, evaluation.actionKey);
    if (evaluation.hostHints.length > 0) {
      for (const host of evaluation.hostHints) {
        this.seenNetworkHosts.add(host.toLowerCase());
      }
    }
  }

  formatYellowNarration(evaluation: ToolApprovalEvaluation): string {
    if (!evaluation.implicitDelayMs || evaluation.implicitDelayMs <= 0) {
      return evaluation.intent;
    }
    return `${evaluation.intent}. Waiting ${YELLOW_IMPLICIT_DELAY_SECS}s for interruption before running.`;
  }

  private shouldApplyImplicitDelay(
    toolName: string,
    channelId: string | undefined,
  ): boolean {
    if (isVoiceChannelId(channelId)) return false;
    const lowerTool = toolName.trim().toLowerCase();
    if (!lowerTool.startsWith('browser_')) return true;
    return IMPLICIT_DELAY_BROWSER_INPUT_TOOLS.has(lowerTool);
  }

  formatApprovalRequest(evaluation: ToolApprovalEvaluation): string {
    const expiresIn = this.loadedPolicy.approvalTimeoutSecs;
    const requestLabel = evaluation.requestId
      ? `Approval ID: ${evaluation.requestId}`
      : '';
    const optionLines = evaluation.pinned
      ? [
          'Reply `yes` to approve once.',
          'Reply `yes for session` is unavailable for pinned-sensitive actions.',
          'Reply `yes for agent` is unavailable for pinned-sensitive actions.',
          'Reply `yes for all` is unavailable for pinned-sensitive actions.',
          'Reply `no` to deny.',
        ]
      : [
          'Reply `yes` to approve once.',
          'Reply `yes for session` to trust this action for this session.',
          'Reply `yes for agent` to trust it for this agent.',
          'Reply `yes for all` to add this action to the workspace allowlist.',
          'Reply `no` to deny.',
        ];
    return [
      `I need your approval before I ${evaluation.intent.toLowerCase()}.`,
      `Proposed action: ${evaluation.commandPreview || evaluation.intent}`,
      `Classifier reasoning: ${formatStakesReasoning(evaluation.stakesScore)}`,
      ...(evaluation.escalationTarget
        ? [
            `Escalation target: ${evaluation.escalationTarget.channel} / ${evaluation.escalationTarget.recipient}`,
          ]
        : []),
      `Why: ${evaluation.reason}`,
      `If you skip this, ${evaluation.consequenceIfDenied.charAt(0).toLowerCase()}${evaluation.consequenceIfDenied.slice(1)}`,
      requestLabel,
      ...optionLines,
      `Approval expires in ${expiresIn}s.`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private getOrCreatePending(
    input: Omit<PendingApproval, 'id' | 'createdAtMs' | 'expiresAtMs'>,
  ): PendingApproval {
    for (const pending of this.pending.values()) {
      if (pending.fingerprint === input.fingerprint) return pending;
    }
    const createdAtMs = Date.now();
    const pending: PendingApproval = {
      ...input,
      id: randomUUID().slice(0, 8),
      createdAtMs,
      expiresAtMs: createdAtMs + this.loadedPolicy.approvalTimeoutSecs * 1_000,
    };
    this.pending.set(pending.id, pending);
    return pending;
  }

  private resolvePendingTarget(requestedId: string): PendingApproval | null {
    if (requestedId) {
      const direct = this.pending.get(requestedId);
      if (direct) return direct;
      return null;
    }
    let latest: PendingApproval | null = null;
    for (const pending of this.pending.values()) {
      if (!latest || pending.createdAtMs > latest.createdAtMs) latest = pending;
    }
    return latest;
  }

  private cleanupExpiredPending(): void {
    const now = Date.now();
    for (const [id, pending] of this.pending.entries()) {
      if (pending.expiresAtMs <= now) {
        this.pending.delete(id);
      }
    }
  }

  private bumpCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) || 0) + 1);
  }

  private resolveAutonomyLevel(params: {
    toolName: string;
    actionKey: string;
  }): AutonomyLevel {
    const toolName = params.toolName.trim().toLowerCase();
    const actionKey = params.actionKey.trim().toLowerCase();
    return (
      this.loadedPolicy.autonomy.actions[actionKey] ||
      this.loadedPolicy.autonomy.tools[toolName] ||
      this.loadedPolicy.autonomy.defaultLevel
    );
  }

  private classifyNetworkTargets(params: {
    targets: Array<{
      host: string;
      port: number;
      path: string;
      method: string;
    }>;
    intent: string;
    consequenceIfDenied: string;
    commandPreview: string;
  }): ClassifiedAction {
    const primaryHost = normalizeHostScope(params.targets[0]?.host || '');
    const hostHints = [
      ...new Set(
        params.targets.map((target) => normalizeHostScope(target.host)),
      ),
    ];
    let matchedAllowRule = false;

    for (const target of params.targets) {
      const evaluation = this.evaluateNetworkAccess(target);
      if (evaluation.decision === 'deny') {
        return {
          tier: 'red',
          actionKey: `network:${primaryHost}`,
          intent: params.intent,
          consequenceIfDenied: params.consequenceIfDenied,
          reason: 'this host is blocked by approval policy',
          commandPreview: params.commandPreview,
          pathHints: [],
          hostHints,
          writeIntent: false,
          promotableRed: false,
          stickyYellow: true,
          hardDeny: true,
        };
      }
      if (evaluation.decision === 'prompt') {
        return {
          tier: 'yellow',
          actionKey: `network:${primaryHost}`,
          intent: params.intent,
          consequenceIfDenied: params.consequenceIfDenied,
          reason: 'network default policy denies unlisted hosts',
          commandPreview: params.commandPreview,
          pathHints: [],
          hostHints,
          writeIntent: false,
          promotableRed: false,
          stickyYellow: true,
        };
      }
      if (evaluation.matchedRule?.action === 'allow') {
        matchedAllowRule = true;
      }
    }

    return {
      tier: 'green',
      actionKey: `network:${primaryHost}`,
      intent: params.intent,
      consequenceIfDenied: params.consequenceIfDenied,
      reason: matchedAllowRule
        ? 'this host is allowlisted in approval policy'
        : 'network default policy allows this host',
      commandPreview: params.commandPreview,
      pathHints: [],
      hostHints,
      writeIntent: false,
      promotableRed: false,
      stickyYellow: true,
    };
  }

  private classifyAction(
    toolName: string,
    args: Record<string, unknown>,
  ): ClassifiedAction {
    const lowerTool = toolName.toLowerCase();

    if (
      lowerTool === 'read' ||
      lowerTool === 'glob' ||
      lowerTool === 'grep' ||
      lowerTool === 'session_search'
    ) {
      return {
        tier: 'green',
        actionKey: lowerTool,
        intent: `run ${toolName}`,
        consequenceIfDenied: 'I will continue without this lookup.',
        reason: 'this is a read-only operation',
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool === 'message') {
      const action = normalizeText(args.action).toLowerCase();
      const readonlyAction =
        action === 'read' ||
        action === 'member-info' ||
        action === 'channel-info';
      return {
        tier: readonlyAction ? 'green' : 'yellow',
        actionKey: action ? `message:${action}` : 'message',
        intent: `run message${action ? ` ${action}` : ''}`,
        consequenceIfDenied:
          action === 'send'
            ? 'no message will be sent.'
            : 'I will continue without this message lookup.',
        reason: readonlyAction
          ? 'this is a read-only channel operation'
          : 'this action may change channel state',
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: action === 'send',
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool === 'delete') {
      const rawPath = normalizeText(args.path);
      const key = rawPath
        ? `delete:${primaryPathKey(rawPath)}`
        : 'delete:unknown';
      const promotable = /(node_modules|dist|build|coverage|\.cache)/i.test(
        rawPath,
      );
      return {
        tier: 'red',
        actionKey: key,
        intent: `delete \`${rawPath || '(unknown path)'}\``,
        consequenceIfDenied: 'the file will remain unchanged.',
        reason: 'deletion is destructive',
        commandPreview: normalizePreview(rawPath),
        pathHints: rawPath ? [rawPath] : [],
        hostHints: [],
        writeIntent: true,
        promotableRed: promotable,
        stickyYellow: promotable,
      };
    }

    if (
      lowerTool === 'write' ||
      lowerTool === 'edit' ||
      lowerTool === 'memory'
    ) {
      const rawPath = normalizeText(
        args.path || args.file_path || args.target || args.action,
      );
      const keyBase =
        lowerTool === 'memory'
          ? 'memory'
          : `${lowerTool}:${primaryPathKey(rawPath || 'workspace')}`;
      return {
        tier: 'yellow',
        actionKey: keyBase,
        intent:
          lowerTool === 'memory'
            ? 'update durable memory'
            : `${lowerTool === 'write' ? 'write' : 'edit'} \`${rawPath || '(unknown path)'}\``,
        consequenceIfDenied:
          lowerTool === 'memory'
            ? 'new memory will not be persisted.'
            : 'the file will stay unchanged.',
        reason: 'this modifies project files',
        commandPreview: normalizePreview(rawPath || JSON.stringify(args)),
        pathHints: rawPath ? [rawPath] : [],
        hostHints: [],
        writeIntent: true,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool === 'web_search') {
      const provider = normalizeText(args.provider).toLowerCase();
      const providerTargets = (() => {
        switch (provider) {
          case 'brave':
            return [
              {
                host: 'api.search.brave.com',
                port: 443,
                path: '/',
                method: 'GET',
              },
            ];
          case 'perplexity':
            return [
              {
                host: 'api.perplexity.ai',
                port: 443,
                path: '/',
                method: 'POST',
              },
            ];
          case 'tavily':
            return [
              { host: 'api.tavily.com', port: 443, path: '/', method: 'POST' },
            ];
          case 'duckduckgo':
            return [
              {
                host: 'html.duckduckgo.com',
                port: 443,
                path: '/',
                method: 'GET',
              },
            ];
          case 'searxng':
            return extractHostsFromUrlLikeText(
              process.env.SEARXNG_BASE_URL || '',
            ).map((host) => ({
              host,
              port: 443,
              path: '/',
              method: 'GET',
            }));
          default:
            return [
              {
                host: 'api.search.brave.com',
                port: 443,
                path: '/',
                method: 'GET',
              },
              {
                host: 'api.perplexity.ai',
                port: 443,
                path: '/',
                method: 'POST',
              },
              { host: 'api.tavily.com', port: 443, path: '/', method: 'POST' },
              {
                host: 'html.duckduckgo.com',
                port: 443,
                path: '/',
                method: 'GET',
              },
            ];
        }
      })();
      if (providerTargets.length === 0) {
        return {
          tier: 'yellow',
          actionKey: 'network:web-search',
          intent: `search the web via ${provider || 'configured providers'}`,
          consequenceIfDenied:
            'I will avoid external search providers and continue with local context only.',
          reason: 'this is an external network action',
          commandPreview: normalizePreview(JSON.stringify(args)),
          pathHints: [],
          hostHints: [],
          writeIntent: false,
          promotableRed: false,
          stickyYellow: true,
        };
      }
      return this.classifyNetworkTargets({
        targets: providerTargets,
        intent: `search the web via ${provider || 'configured providers'}`,
        consequenceIfDenied:
          'I will avoid external search providers and continue with local context only.',
        commandPreview: normalizePreview(JSON.stringify(args)),
      });
    }

    if (
      lowerTool === 'web_fetch' ||
      lowerTool === 'web_extract' ||
      lowerTool === 'http_request' ||
      lowerTool === 'browser_navigate'
    ) {
      const rawUrl = normalizeText(args.url);
      const target = parseUrlNetworkTarget(rawUrl);
      if (!target) {
        return {
          tier: 'yellow',
          actionKey: 'network:unknown-host',
          intent: 'access external host',
          consequenceIfDenied:
            'I will avoid contacting that host and use existing local context only.',
          reason: 'this is an external network action',
          commandPreview: normalizePreview(rawUrl),
          pathHints: [],
          hostHints: [],
          writeIntent: false,
          promotableRed: false,
          stickyYellow: true,
        };
      }
      return this.classifyNetworkTargets({
        targets: [
          {
            ...target,
            method:
              lowerTool === 'http_request'
                ? String(args.method || 'GET')
                : 'GET',
          },
        ],
        intent: `access ${normalizeHostScope(target.host)}`,
        consequenceIfDenied:
          'I will avoid contacting that host and use existing local context only.',
        commandPreview: normalizePreview(rawUrl),
      });
    }

    if (lowerTool === 'vision_analyze' || lowerTool === 'image') {
      return {
        tier: 'green',
        actionKey: lowerTool,
        intent: `run ${toolName}`,
        consequenceIfDenied: 'I will continue without image analysis.',
        reason: 'this action is read-only analysis of the provided image',
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool === 'delegate') {
      return {
        tier: 'green',
        actionKey: lowerTool,
        intent: 'start delegated agent work',
        consequenceIfDenied: 'I will do the work in the current agent.',
        reason:
          'delegation is internal orchestration; child tool calls are classified separately',
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool.startsWith('browser_')) {
      return {
        tier: 'yellow',
        actionKey: lowerTool,
        intent: `run ${toolName}`,
        consequenceIfDenied:
          'I will continue without browser/vision interaction.',
        reason: 'this action interacts with external runtime state',
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool.includes('__')) {
      const kind = classifyMcpTool(lowerTool);
      const [serverName, rawToolName] = lowerTool.split('__', 2);
      const toolLabel = rawToolName || lowerTool;
      const actionKey = `mcp:${serverName || 'server'}:${kind}`;

      if (kind === 'read' || kind === 'search' || kind === 'fetch') {
        return {
          tier: 'green',
          actionKey,
          intent: `run MCP tool ${toolLabel}`,
          consequenceIfDenied: 'I will continue without this MCP lookup.',
          reason: 'this MCP tool appears read-only',
          commandPreview: normalizePreview(JSON.stringify(args)),
          pathHints: [],
          hostHints: [],
          writeIntent: false,
          promotableRed: false,
          stickyYellow: false,
        };
      }

      if (kind === 'delete' || kind === 'execute') {
        return {
          tier: 'red',
          actionKey,
          intent: `run MCP tool ${toolLabel}`,
          consequenceIfDenied:
            kind === 'delete'
              ? 'I will continue without deleting anything.'
              : 'I will continue without executing that action.',
          reason:
            kind === 'delete'
              ? 'this MCP tool appears destructive'
              : 'this MCP tool appears to execute commands or external actions',
          commandPreview: normalizePreview(JSON.stringify(args)),
          pathHints: [],
          hostHints: [],
          writeIntent: true,
          promotableRed: false,
          stickyYellow: false,
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
        commandPreview: normalizePreview(JSON.stringify(args)),
        pathHints: [],
        hostHints: [],
        writeIntent: kind === 'edit',
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (lowerTool === 'bash') {
      return this.classifyBashAction(args);
    }

    return {
      tier: 'yellow',
      actionKey: lowerTool,
      intent: `run ${toolName}`,
      consequenceIfDenied: 'I will continue without this action.',
      reason: 'this action may have side effects',
      commandPreview: normalizePreview(JSON.stringify(args)),
      pathHints: [],
      hostHints: [],
      writeIntent: false,
      promotableRed: false,
      stickyYellow: false,
    };
  }

  private classifyBashAction(args: Record<string, unknown>): ClassifiedAction {
    const command = normalizeText(args.command);
    const inspectionSurface = buildBashInspectionSurface(command);
    const lower = command.toLowerCase();
    const hosts = extractHostsFromUrlLikeText(command);
    const httpTargets = [...command.matchAll(URL_RE)]
      .map((match) => parseUrlNetworkTarget(match[0]))
      .filter(
        (
          target,
        ): target is {
          host: string;
          port: number;
          path: string;
        } => Boolean(target),
      );
    const httpHostSet = new Set(httpTargets.map((target) => target.host));
    const unseenHosts = hosts.filter(
      (host) => !httpHostSet.has(host) && !this.seenNetworkHosts.has(host),
    );
    const absPaths = extractAbsolutePaths(inspectionSurface);
    const likelyWritePaths = extractLikelyWritePaths(inspectionSurface);
    const writeIntent =
      WRITE_INTENT_RE.test(inspectionSurface) ||
      DELETE_RE.test(inspectionSurface) ||
      INSTALL_RE.test(inspectionSurface) ||
      GIT_WRITE_RE.test(inspectionSurface);

    if (CRITICAL_BASH_RE.test(command) || FORCE_PUSH_RE.test(command)) {
      return {
        tier: 'red',
        actionKey: 'bash:critical',
        intent: `run \`${normalizePreview(command)}\``,
        consequenceIfDenied:
          'I will not execute that command and will propose a safer alternative.',
        reason: 'the command is high-risk or security-sensitive',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent,
        promotableRed: false,
        stickyYellow: true,
      };
    }

    if (this.loadedPolicy.workspaceFence && writeIntent) {
      const workspaceFencePaths =
        likelyWritePaths.length > 0 ? likelyWritePaths : absPaths;
      const outsideWorkspace = workspaceFencePaths.find(
        (entry) =>
          !isWorkspacePath(entry) &&
          !entry.startsWith('/dev/null') &&
          !isScratchPath(entry),
      );
      if (outsideWorkspace) {
        return {
          tier: 'red',
          actionKey: 'bash:workspace-fence',
          intent: `write outside workspace (\`${outsideWorkspace}\`)`,
          consequenceIfDenied: 'writes outside the workspace will be skipped.',
          reason: 'workspace fence blocks writes outside /workspace',
          commandPreview: normalizePreview(command),
          pathHints: absPaths,
          hostHints: hosts,
          writeIntent,
          promotableRed: false,
          stickyYellow: true,
        };
      }
    }

    if (DELETE_RE.test(inspectionSurface)) {
      const promotable = /(node_modules|dist|build|coverage|\.cache)/i.test(
        lower,
      );
      return {
        tier: 'red',
        actionKey: promotable ? 'bash:delete-cache' : 'bash:delete',
        intent: `run destructive command \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'I will continue without deleting files.',
        reason: 'the command deletes files',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent: true,
        promotableRed: promotable,
        stickyYellow: promotable,
      };
    }

    if (UNKNOWN_SCRIPT_RE.test(inspectionSurface)) {
      return {
        tier: 'red',
        actionKey: 'bash:script',
        intent: `run script \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'I will avoid executing unknown scripts.',
        reason: 'script execution is treated as high risk',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent,
        promotableRed: false,
        stickyYellow: true,
      };
    }

    if (httpTargets.length > 0 && NETWORK_COMMAND_RE.test(inspectionSurface)) {
      return this.classifyNetworkTargets({
        targets: httpTargets.map((target) => ({
          ...target,
          method: inferBashHttpMethod(command),
        })),
        intent: `contact ${normalizeHostScope(httpTargets[0]?.host || 'unknown-host')}`,
        consequenceIfDenied: 'I will keep the task local and avoid that host.',
        commandPreview: normalizePreview(command),
      });
    }

    if (unseenHosts.length > 0 && NETWORK_COMMAND_RE.test(inspectionSurface)) {
      return {
        tier: 'red',
        actionKey: `bash:network:${unseenHosts[0]}`,
        intent: `contact new host ${unseenHosts[0]}`,
        consequenceIfDenied: 'I will keep the task local and avoid that host.',
        reason: 'the command reaches a new network host',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent,
        promotableRed: true,
        stickyYellow: true,
      };
    }

    const hostAppControl =
      /\bosascript\b/.test(lower) ||
      /\bopen\s+-a\b/.test(lower) ||
      /\bopen\s+['"]?(music|itms|itmss):\/\//.test(lower);
    if (hostAppControl) {
      return {
        tier: 'red',
        actionKey: 'bash:host-control',
        intent: `control a local app with \`${normalizePreview(command)}\``,
        consequenceIfDenied:
          'I will avoid controlling host applications and keep the task read-only.',
        reason: 'this command controls host GUI or application state',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent,
        promotableRed: false,
        stickyYellow: true,
      };
    }

    if (INSTALL_RE.test(inspectionSurface)) {
      return {
        tier: 'yellow',
        actionKey: 'bash:install-deps',
        intent: `install dependencies with \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'dependency installation will be skipped.',
        reason: 'this changes the local dependency state',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent: true,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (
      GIT_WRITE_RE.test(inspectionSurface) ||
      WRITE_INTENT_RE.test(inspectionSurface)
    ) {
      return {
        tier: 'yellow',
        actionKey: 'bash:write-op',
        intent: `run mutating command \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'I will continue without mutating the workspace.',
        reason: 'this command has write side effects',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent: true,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (READ_ONLY_BASH_RE.test(inspectionSurface)) {
      return {
        tier: 'green',
        actionKey: 'bash:read-only',
        intent: `run read-only command \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'I will continue without that check.',
        reason: 'this command is read-only',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    if (READ_ONLY_PDF_SCRIPT_RE.test(inspectionSurface)) {
      return {
        tier: 'green',
        actionKey: 'bash:pdf-read-only',
        intent: `run read-only PDF command \`${normalizePreview(command)}\``,
        consequenceIfDenied: 'I will continue without that PDF check.',
        reason: 'this command only reads PDF content',
        commandPreview: normalizePreview(command),
        pathHints: absPaths,
        hostHints: hosts,
        writeIntent: false,
        promotableRed: false,
        stickyYellow: false,
      };
    }

    return {
      tier: 'yellow',
      actionKey: 'bash:other',
      intent: `run shell command \`${normalizePreview(command)}\``,
      consequenceIfDenied: 'I will continue without running that command.',
      reason: 'this command may change local state',
      commandPreview: normalizePreview(command),
      pathHints: absPaths,
      hostHints: hosts,
      writeIntent,
      promotableRed: false,
      stickyYellow: false,
    };
  }

  private isPinnedRed(input: {
    toolName: string;
    preview: string;
    pathHints: string[];
    args: Record<string, unknown>;
  }): boolean {
    const fullText =
      `${input.toolName} ${input.preview} ${normalizeText(JSON.stringify(input.args))}`.toLowerCase();

    // Hard-coded pinned path safety net.
    const hardPinnedPaths = ['.env*', '/etc/**', '~/.ssh/**'];
    for (const pathHint of input.pathHints) {
      if (
        hardPinnedPaths.some((pattern) => matchesPathPattern(pathHint, pattern))
      )
        return true;
    }
    if (fullText.includes('git push --force')) return true;

    for (const rule of this.loadedPolicy.pinnedRed) {
      if (
        Array.isArray(rule.tools) &&
        rule.tools.some(
          (tool) => tool.toLowerCase() === input.toolName.toLowerCase(),
        )
      ) {
        return true;
      }
      if (rule.pattern) {
        try {
          const re = new RegExp(rule.pattern, 'i');
          if (re.test(fullText)) return true;
        } catch (error) {
          this.warnInvalidPinnedRedPattern(rule.pattern, error);
        }
      }
      if (Array.isArray(rule.paths) && rule.paths.length > 0) {
        for (const pathHint of input.pathHints) {
          if (
            rule.paths.some((pattern) => matchesPathPattern(pathHint, pattern))
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  private warnInvalidPinnedRedPattern(pattern: string, error: unknown): void {
    if (this.invalidPinnedRedPatternWarnings.has(pattern)) return;
    this.invalidPinnedRedPatternWarnings.add(pattern);
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[approval-policy] invalid pinned_red regex in ${this.policyPath}; rule will not match: ${pattern} (${message})`,
    );
  }
}
