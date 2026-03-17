export interface WorkflowTrigger {
  kind: 'schedule' | 'channel_event' | 'reaction' | 'keyword' | 'webhook';
  cronExpr?: string;
  runAt?: string;
  everyMs?: number;
  sourceChannel?: string;
  eventType?: string;
  fromPattern?: string;
  contentPattern?: string;
  reactionEmoji?: string;
  subjectPattern?: string;
}

export interface WorkflowDelivery {
  kind: 'channel' | 'email' | 'webhook' | 'originating';
  channelType?: string;
  target?: string;
  channelName?: string;
}

export type WorkflowBootstrapContextMode = 'full' | 'light';
export type WorkflowStepKind = 'agent' | 'deliver' | 'approval';
export type WorkflowRetryOn =
  | 'timeout'
  | 'delivery_error'
  | 'rate_limit'
  | 'transient';

export interface WorkflowRetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  strategy?: 'fixed' | 'exponential';
  retryOn?: WorkflowRetryOn[];
}

export interface WorkflowDefaults {
  timeoutMs?: number;
  retryPolicy?: WorkflowRetryPolicy;
  lightContext?: boolean;
}

export interface WorkflowStep {
  id: string;
  kind: WorkflowStepKind;
  prompt?: string;
  input?: string;
  delivery?: WorkflowDelivery;
  approvalPrompt?: string;
  dependsOn?: string[];
  deliverTo?: WorkflowDelivery;
  extractAs?: string;
  timeoutMs?: number;
  retryPolicy?: WorkflowRetryPolicy;
  lightContext?: boolean;
}

export interface WorkflowSpec {
  version: 2;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  delivery: WorkflowDelivery;
  defaults?: WorkflowDefaults;
  context?: Record<string, string>;
}

interface LegacyWorkflowStepV1 {
  id: string;
  prompt: string;
  dependsOn?: string[];
  deliverTo?: WorkflowDelivery;
  extractAs?: string;
}

interface LegacyWorkflowSpecV1 {
  version: 1;
  trigger: WorkflowTrigger;
  steps: LegacyWorkflowStepV1[];
  delivery: WorkflowDelivery;
  context?: Record<string, string>;
}

export type WorkflowSideEffect =
  | {
      action: 'create';
      name: string;
      description: string;
      naturalLanguage: string;
      spec: WorkflowSpec;
    }
  | { action: 'remove'; workflowId: number }
  | { action: 'toggle'; workflowId: number };

export type WorkflowRunStatus = 'success' | 'error' | 'partial';

export interface StoredWorkflow {
  id: number;
  session_id: string;
  agent_id: string;
  channel_id: string;
  name: string;
  description: string;
  spec: WorkflowSpec;
  natural_language: string;
  enabled: number;
  companion_task_id: number | null;
  last_run: string | null;
  last_status: WorkflowRunStatus | null;
  consecutive_errors: number;
  run_count: number;
  created_at: string;
  updated_at: string;
}

export interface WorkflowCreateInput {
  sessionId: string;
  agentId: string;
  channelId: string;
  name: string;
  description?: string;
  spec: WorkflowSpec;
  naturalLanguage: string;
  enabled?: boolean;
  companionTaskId?: number | null;
}

export interface WorkflowUpdateInput {
  name?: string;
  description?: string;
  spec?: WorkflowSpec;
  naturalLanguage?: string;
  enabled?: boolean;
  companionTaskId?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function readPositiveInteger(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : null;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const deduped = [
    ...new Set(
      value
        .map((entry) => readString(entry))
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
  return deduped.length > 0 ? deduped : undefined;
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    const normalizedKey = key.trim();
    const normalizedValue = readString(raw);
    if (!normalizedKey || !normalizedValue) continue;
    out[normalizedKey] = normalizedValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeWorkflowDelivery(value: unknown): WorkflowDelivery | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (
    kind !== 'channel' &&
    kind !== 'email' &&
    kind !== 'webhook' &&
    kind !== 'originating'
  ) {
    return null;
  }
  return {
    kind,
    channelType: readString(value.channelType) || undefined,
    target: readString(value.target) || undefined,
    channelName: readString(value.channelName) || undefined,
  };
}

function normalizeWorkflowTrigger(value: unknown): WorkflowTrigger | null {
  if (!isRecord(value)) return null;
  const kind = readString(value.kind);
  if (
    kind !== 'schedule' &&
    kind !== 'channel_event' &&
    kind !== 'reaction' &&
    kind !== 'keyword' &&
    kind !== 'webhook'
  ) {
    return null;
  }
  const trigger: WorkflowTrigger = { kind };
  const cronExpr = readString(value.cronExpr);
  if (cronExpr) trigger.cronExpr = cronExpr;
  const runAt = readString(value.runAt);
  if (runAt) trigger.runAt = runAt;
  const everyMs = readPositiveInteger(value.everyMs);
  if (everyMs != null) trigger.everyMs = everyMs;
  const sourceChannel = readString(value.sourceChannel);
  if (sourceChannel) trigger.sourceChannel = sourceChannel;
  const eventType = readString(value.eventType);
  if (eventType) trigger.eventType = eventType;
  const fromPattern = readString(value.fromPattern);
  if (fromPattern) trigger.fromPattern = fromPattern;
  const contentPattern = readString(value.contentPattern);
  if (contentPattern) trigger.contentPattern = contentPattern;
  const reactionEmoji = readString(value.reactionEmoji);
  if (reactionEmoji) trigger.reactionEmoji = reactionEmoji;
  const subjectPattern = readString(value.subjectPattern);
  if (subjectPattern) trigger.subjectPattern = subjectPattern;
  return trigger;
}

function normalizeWorkflowRetryPolicy(
  value: unknown,
): WorkflowRetryPolicy | undefined {
  if (!isRecord(value)) return undefined;
  const maxAttempts = readPositiveInteger(value.maxAttempts);
  if (maxAttempts == null) return undefined;
  const strategy = readString(value.strategy);
  const retryOn = normalizeStringArray(value.retryOn)?.filter(
    (entry): entry is WorkflowRetryOn =>
      entry === 'timeout' ||
      entry === 'delivery_error' ||
      entry === 'rate_limit' ||
      entry === 'transient',
  );
  return {
    maxAttempts,
    backoffMs: readPositiveInteger(value.backoffMs) || undefined,
    strategy:
      strategy === 'fixed' || strategy === 'exponential' ? strategy : undefined,
    retryOn: retryOn && retryOn.length > 0 ? retryOn : undefined,
  };
}

function normalizeWorkflowDefaults(
  value: unknown,
): WorkflowDefaults | undefined {
  if (!isRecord(value)) return undefined;
  const defaults: WorkflowDefaults = {};
  const timeoutMs = readPositiveInteger(value.timeoutMs);
  if (timeoutMs != null) defaults.timeoutMs = timeoutMs;
  const retryPolicy = normalizeWorkflowRetryPolicy(value.retryPolicy);
  if (retryPolicy) defaults.retryPolicy = retryPolicy;
  const lightContext = readBoolean(value.lightContext);
  if (lightContext !== undefined) defaults.lightContext = lightContext;
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function normalizeLegacyWorkflowStep(
  value: unknown,
): LegacyWorkflowStepV1 | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  const prompt = readString(value.prompt);
  if (!id || !prompt) return null;
  return {
    id,
    prompt,
    dependsOn: normalizeStringArray(value.dependsOn),
    deliverTo: normalizeWorkflowDelivery(value.deliverTo) || undefined,
    extractAs: readString(value.extractAs) || undefined,
  };
}

function normalizeWorkflowStep(value: unknown): WorkflowStep | null {
  if (!isRecord(value)) return null;
  const id = readString(value.id);
  if (!id) return null;

  const inferredKind =
    readString(value.kind) || (readString(value.prompt) ? 'agent' : null);
  if (
    inferredKind !== 'agent' &&
    inferredKind !== 'deliver' &&
    inferredKind !== 'approval'
  ) {
    return null;
  }

  const step: WorkflowStep = {
    id,
    kind: inferredKind,
    dependsOn: normalizeStringArray(value.dependsOn),
    deliverTo: normalizeWorkflowDelivery(value.deliverTo) || undefined,
    extractAs: readString(value.extractAs) || undefined,
    timeoutMs: readPositiveInteger(value.timeoutMs) || undefined,
    retryPolicy: normalizeWorkflowRetryPolicy(value.retryPolicy),
    lightContext: readBoolean(value.lightContext),
  };

  if (inferredKind === 'agent') {
    const prompt = readString(value.prompt);
    if (!prompt) return null;
    step.prompt = prompt;
    step.input = readString(value.input) || undefined;
    return step;
  }

  if (inferredKind === 'deliver') {
    const input = readString(value.input);
    const delivery =
      normalizeWorkflowDelivery(value.delivery) ||
      normalizeWorkflowDelivery(value.deliverTo);
    if (!input || !delivery) return null;
    step.input = input;
    step.delivery = delivery;
    return step;
  }

  const approvalPrompt =
    readString(value.approvalPrompt) || readString(value.prompt);
  if (!approvalPrompt) return null;
  step.approvalPrompt = approvalPrompt;
  step.input = readString(value.input) || undefined;
  return step;
}

function upgradeLegacyWorkflowSpec(spec: LegacyWorkflowSpecV1): WorkflowSpec {
  return {
    version: 2,
    trigger: spec.trigger,
    steps: spec.steps.map((step) => ({
      id: step.id,
      kind: 'agent',
      prompt: step.prompt,
      dependsOn: step.dependsOn,
      deliverTo: step.deliverTo,
      extractAs: step.extractAs,
    })),
    delivery: spec.delivery,
    context: spec.context,
  };
}

function isValidScheduleTrigger(trigger: WorkflowTrigger): boolean {
  if (trigger.kind !== 'schedule') return true;
  const configured = [
    Boolean(trigger.cronExpr),
    Boolean(trigger.runAt),
    trigger.everyMs != null,
  ].filter(Boolean).length;
  return configured === 1;
}

function isMeaningfulKeywordTrigger(trigger: WorkflowTrigger): boolean {
  if (trigger.kind !== 'keyword') return true;
  return Boolean(trigger.contentPattern);
}

function validateWorkflowSteps(steps: WorkflowStep[]): boolean {
  if (steps.length === 0) return false;
  const stepIds = new Set<string>();
  for (const step of steps) {
    if (stepIds.has(step.id)) return false;
    stepIds.add(step.id);
  }
  for (const step of steps) {
    if (step.dependsOn?.some((dependency) => !stepIds.has(dependency))) {
      return false;
    }
    if (step.kind === 'agent' && !step.prompt) return false;
    if (step.kind === 'deliver' && (!step.input || !step.delivery)) {
      return false;
    }
    if (step.kind === 'approval' && !step.approvalPrompt) {
      return false;
    }
  }
  return true;
}

export function normalizeWorkflowSpec(value: unknown): WorkflowSpec | null {
  if (!isRecord(value)) return null;
  const version = Number(value.version ?? 1);
  const trigger = normalizeWorkflowTrigger(value.trigger);
  if (!trigger) return null;
  if (!isValidScheduleTrigger(trigger)) return null;
  if (!isMeaningfulKeywordTrigger(trigger)) return null;

  if (version === 1) {
    if (!Array.isArray(value.steps) || value.steps.length === 0) return null;
    const steps = value.steps
      .map((step) => normalizeLegacyWorkflowStep(step))
      .filter((step): step is LegacyWorkflowStepV1 => Boolean(step));
    if (steps.length !== value.steps.length) return null;
    const delivery = normalizeWorkflowDelivery(value.delivery);
    if (!delivery) return null;
    return upgradeLegacyWorkflowSpec({
      version: 1,
      trigger,
      steps,
      delivery,
      context: normalizeStringRecord(value.context),
    });
  }

  if (version !== 2) return null;
  if (!Array.isArray(value.steps) || value.steps.length === 0) return null;
  const steps = value.steps
    .map((step) => normalizeWorkflowStep(step))
    .filter((step): step is WorkflowStep => Boolean(step));
  if (steps.length !== value.steps.length) return null;
  if (!validateWorkflowSteps(steps)) return null;
  const delivery = normalizeWorkflowDelivery(value.delivery);
  if (!delivery) return null;

  return {
    version: 2,
    trigger,
    steps,
    delivery,
    defaults: normalizeWorkflowDefaults(value.defaults),
    context: normalizeStringRecord(value.context),
  };
}

export function upgradeWorkflowSpec(value: unknown): WorkflowSpec | null {
  return normalizeWorkflowSpec(value);
}

export function validateWorkflowSpec(value: unknown):
  | {
      ok: true;
      spec: WorkflowSpec;
    }
  | {
      ok: false;
      error: string;
    } {
  if (!isRecord(value)) {
    return { ok: false, error: 'Workflow spec must be a JSON object.' };
  }
  const version = Number(value.version ?? 1);
  if (version !== 1 && version !== 2) {
    return { ok: false, error: 'Workflow spec version must be 1 or 2.' };
  }
  const spec = normalizeWorkflowSpec(value);
  if (!spec) {
    return {
      ok: false,
      error:
        'Workflow spec is invalid. Check trigger, steps, delivery, retry policy, and dependency references.',
    };
  }
  if (spec.trigger.kind === 'schedule' && spec.steps.length === 0) {
    return {
      ok: false,
      error: 'Schedule workflows must include at least one step.',
    };
  }
  return { ok: true, spec };
}

function yamlQuote(value: string): string {
  return JSON.stringify(value);
}

function pushYamlBlock(
  lines: string[],
  indent: string,
  key: string,
  value: string,
): void {
  const normalized = value.replace(/\r\n/g, '\n');
  if (!normalized) {
    lines.push(`${indent}${key}: ""`);
    return;
  }
  lines.push(`${indent}${key}: |-`);
  for (const line of normalized.split('\n')) {
    lines.push(`${indent}  ${line}`);
  }
}

function pushYamlScalar(
  lines: string[],
  indent: string,
  key: string,
  value: string | number | boolean,
): void {
  if (typeof value === 'string') {
    lines.push(`${indent}${key}: ${yamlQuote(value)}`);
    return;
  }
  lines.push(`${indent}${key}: ${String(value)}`);
}

function appendWorkflowDeliveryYaml(
  lines: string[],
  indent: string,
  delivery: WorkflowDelivery,
): void {
  lines.push(`${indent}kind: ${yamlQuote(delivery.kind)}`);
  if (delivery.channelType) {
    lines.push(`${indent}channelType: ${yamlQuote(delivery.channelType)}`);
  }
  if (delivery.target) {
    lines.push(`${indent}target: ${yamlQuote(delivery.target)}`);
  }
  if (delivery.channelName) {
    lines.push(`${indent}channelName: ${yamlQuote(delivery.channelName)}`);
  }
}

function appendWorkflowTriggerYaml(
  lines: string[],
  indent: string,
  trigger: WorkflowTrigger,
): void {
  lines.push(`${indent}kind: ${yamlQuote(trigger.kind)}`);
  if (trigger.cronExpr) {
    lines.push(`${indent}cronExpr: ${yamlQuote(trigger.cronExpr)}`);
  }
  if (trigger.runAt) {
    lines.push(`${indent}runAt: ${yamlQuote(trigger.runAt)}`);
  }
  if (trigger.everyMs != null) {
    lines.push(`${indent}everyMs: ${trigger.everyMs}`);
  }
  if (trigger.sourceChannel) {
    lines.push(`${indent}sourceChannel: ${yamlQuote(trigger.sourceChannel)}`);
  }
  if (trigger.eventType) {
    lines.push(`${indent}eventType: ${yamlQuote(trigger.eventType)}`);
  }
  if (trigger.fromPattern) {
    lines.push(`${indent}fromPattern: ${yamlQuote(trigger.fromPattern)}`);
  }
  if (trigger.contentPattern) {
    lines.push(`${indent}contentPattern: ${yamlQuote(trigger.contentPattern)}`);
  }
  if (trigger.reactionEmoji) {
    lines.push(`${indent}reactionEmoji: ${yamlQuote(trigger.reactionEmoji)}`);
  }
  if (trigger.subjectPattern) {
    lines.push(`${indent}subjectPattern: ${yamlQuote(trigger.subjectPattern)}`);
  }
}

function appendWorkflowRetryPolicyYaml(
  lines: string[],
  indent: string,
  retryPolicy: WorkflowRetryPolicy,
): void {
  pushYamlScalar(lines, indent, 'maxAttempts', retryPolicy.maxAttempts);
  if (retryPolicy.backoffMs != null) {
    pushYamlScalar(lines, indent, 'backoffMs', retryPolicy.backoffMs);
  }
  if (retryPolicy.strategy) {
    pushYamlScalar(lines, indent, 'strategy', retryPolicy.strategy);
  }
  if (retryPolicy.retryOn && retryPolicy.retryOn.length > 0) {
    lines.push(`${indent}retryOn:`);
    for (const entry of retryPolicy.retryOn) {
      lines.push(`${indent}  - ${yamlQuote(entry)}`);
    }
  }
}

function appendWorkflowDefaultsYaml(
  lines: string[],
  indent: string,
  defaults: WorkflowDefaults,
): void {
  if (defaults.timeoutMs != null) {
    pushYamlScalar(lines, indent, 'timeoutMs', defaults.timeoutMs);
  }
  if (defaults.lightContext !== undefined) {
    pushYamlScalar(lines, indent, 'lightContext', defaults.lightContext);
  }
  if (defaults.retryPolicy) {
    lines.push(`${indent}retryPolicy:`);
    appendWorkflowRetryPolicyYaml(lines, `${indent}  `, defaults.retryPolicy);
  }
}

export function renderWorkflowSpecYaml(spec: WorkflowSpec): string {
  const lines: string[] = [];
  pushYamlScalar(lines, '', 'version', spec.version);
  lines.push('trigger:');
  appendWorkflowTriggerYaml(lines, '  ', spec.trigger);
  if (spec.defaults) {
    lines.push('defaults:');
    appendWorkflowDefaultsYaml(lines, '  ', spec.defaults);
  }
  lines.push('steps:');
  for (const step of spec.steps) {
    lines.push(`  - id: ${yamlQuote(step.id)}`);
    pushYamlScalar(lines, '    ', 'kind', step.kind);
    if (step.dependsOn && step.dependsOn.length > 0) {
      lines.push('    dependsOn:');
      for (const dependency of step.dependsOn) {
        lines.push(`      - ${yamlQuote(dependency)}`);
      }
    }
    if (step.prompt) {
      pushYamlBlock(lines, '    ', 'prompt', step.prompt);
    }
    if (step.input) {
      pushYamlBlock(lines, '    ', 'input', step.input);
    }
    if (step.approvalPrompt) {
      pushYamlBlock(lines, '    ', 'approvalPrompt', step.approvalPrompt);
    }
    if (step.extractAs) {
      lines.push(`    extractAs: ${yamlQuote(step.extractAs)}`);
    }
    if (step.timeoutMs != null) {
      pushYamlScalar(lines, '    ', 'timeoutMs', step.timeoutMs);
    }
    if (step.lightContext !== undefined) {
      pushYamlScalar(lines, '    ', 'lightContext', step.lightContext);
    }
    if (step.retryPolicy) {
      lines.push('    retryPolicy:');
      appendWorkflowRetryPolicyYaml(lines, '      ', step.retryPolicy);
    }
    if (step.deliverTo) {
      lines.push('    deliverTo:');
      appendWorkflowDeliveryYaml(lines, '      ', step.deliverTo);
    }
    if (step.delivery) {
      lines.push('    delivery:');
      appendWorkflowDeliveryYaml(lines, '      ', step.delivery);
    }
  }
  lines.push('delivery:');
  appendWorkflowDeliveryYaml(lines, '  ', spec.delivery);
  if (spec.context && Object.keys(spec.context).length > 0) {
    lines.push('context:');
    for (const key of Object.keys(spec.context).sort((left, right) =>
      left.localeCompare(right),
    )) {
      lines.push(`  ${yamlQuote(key)}: ${yamlQuote(spec.context[key] || '')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function renderWorkflowDefinitionYaml(params: {
  name: string;
  description?: string;
  naturalLanguage: string;
  enabled: boolean;
  companionTaskId?: number | null;
  spec: WorkflowSpec;
}): string {
  const lines: string[] = [];
  pushYamlScalar(lines, '', 'name', params.name);
  if (params.description?.trim()) {
    pushYamlScalar(lines, '', 'description', params.description.trim());
  }
  pushYamlScalar(lines, '', 'enabled', params.enabled);
  if (params.companionTaskId != null) {
    pushYamlScalar(lines, '', 'companionTaskId', params.companionTaskId);
  }
  pushYamlBlock(lines, '', 'naturalLanguage', params.naturalLanguage);
  lines.push(renderWorkflowSpecYaml(params.spec).trimEnd());
  return `${lines.join('\n')}\n`;
}
