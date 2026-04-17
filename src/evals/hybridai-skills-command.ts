import fs from 'node:fs';
import path from 'node:path';
import type { GatewayCommandResult } from '../gateway/gateway-types.js';
import { resolveInstallPath } from '../infra/install-root.js';
import { logger } from '../logger.js';
import { resolveObservedSkillName, type Skill } from '../skills/skills.js';
import type { ToolExecution } from '../types/execution.js';
import {
  joinSections,
  renderKeyValueSection,
  resolveHarnessVersion,
} from './eval-command.js';
import {
  buildDefaultEvalProfile,
  describeEvalProfile,
  type EvalProfile,
  encodeEvalProfileModel,
  isKnownEvalPromptPart,
} from './eval-profile.js';

export type HybridaiSkillFixtureMode = 'implicit' | 'explicit';
export type HybridaiSkillFixtureKind = 'try-it' | 'conversation';

export interface HybridaiSkillFixture {
  id: string;
  docFile: string;
  skill: string;
  prompt: string;
  mode: HybridaiSkillFixtureMode;
  kind: HybridaiSkillFixtureKind;
  turnIndex?: number;
  conversationId?: string;
}

export interface HybridaiSkillFixtureSet {
  generatedAt: string;
  docsRoot: string;
  sourceFiles: string[];
  fixtures: HybridaiSkillFixture[];
}

interface FixtureGradeResult {
  fixture: HybridaiSkillFixture;
  status: 'passed' | 'failed' | 'skipped';
  observedSkill: string | null;
  toolNames: string[];
  sessionId?: string;
  auditPath?: string;
  observationSource?: 'audit.skill.execution' | 'audit.tool.trace' | 'response';
  reason?: string;
  durationMs: number;
  assistantPreview?: string;
}

interface HybridaiSkillsModelRunSummary {
  model: string;
  profiledModel: string;
  startedAt: string;
  finishedAt: string;
  executedFixtures: number;
  passed: number;
  failed: number;
  skipped: number;
  results: FixtureGradeResult[];
}

interface HybridaiSkillsRunSummary {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  mode: 'dry-run' | 'live';
  totalFixtures: number;
  profile?: EvalProfile;
  model?: string;
  executedFixtures?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  filterSkill?: string;
  filterMode?: HybridaiSkillFixtureMode;
  maxFixtures?: number;
  forceExplicit?: boolean;
  results?: FixtureGradeResult[];
  runs?: HybridaiSkillsModelRunSummary[];
}

interface HybridaiSkillsEvalEnvironment {
  baseUrl: string;
  apiKey: string;
  model: string;
  baseModel: string;
  profile: EvalProfile;
}

export function isHybridaiSkillsAlias(value: string): boolean {
  const normalized = String(value || '')
    .trim()
    .toLowerCase();
  return (
    normalized === 'hybridai-skills' ||
    normalized === 'skills' ||
    normalized === 'hybridai_skills'
  );
}

export function resolveHybridaiSkillsDocsRoot(): string {
  return resolveInstallPath('docs', 'development', 'guides', 'skills');
}

export function resolveHybridaiSkillsInstallDir(dataDir: string): string {
  return path.join(dataDir, 'evals', 'hybridai-skills');
}

function getFixturesPath(dataDir: string): string {
  return path.join(resolveHybridaiSkillsInstallDir(dataDir), 'fixtures.jsonl');
}

function getFixturesMetaPath(dataDir: string): string {
  return path.join(
    resolveHybridaiSkillsInstallDir(dataDir),
    'fixtures.meta.json',
  );
}

function getLatestRunPath(dataDir: string): string {
  return path.join(resolveHybridaiSkillsInstallDir(dataDir), 'latest-run.json');
}

const SKILLS_HEADING_RE = /^##\s+([a-z0-9][a-z0-9_-]*)\s*$/i;
const TRY_IT_YOURSELF_RE = /Try it yourself/i;
const CONVERSATION_FLOW_RE = /Conversation flow/i;
const BACKTICK_PROMPT_RE = /^\s*`([^`]+)`\s*$/;
const CONVERSATION_TURN_RE = /^\s*\d+[.)]\s*(.+)$/;

interface SectionParseState {
  skill: string;
  conversationSeq: number;
  promptSeq: number;
}

export function harvestHybridaiSkillsFixtures(
  docsRoot: string,
): HybridaiSkillFixtureSet {
  const entries = fs.existsSync(docsRoot)
    ? fs.readdirSync(docsRoot, { withFileTypes: true })
    : [];
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .filter((name) => name.toLowerCase() !== 'readme.md')
    .sort();

  const fixtures: HybridaiSkillFixture[] = [];
  const sourceFiles: string[] = [];

  for (const file of files) {
    const filePath = path.join(docsRoot, file);
    const text = fs.readFileSync(filePath, 'utf8');
    sourceFiles.push(file);
    const collected = parseSkillsDoc(text, file);
    for (const fixture of collected) {
      fixtures.push(fixture);
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    docsRoot,
    sourceFiles,
    fixtures,
  };
}

function parseSkillsDoc(text: string, docFile: string): HybridaiSkillFixture[] {
  const lines = text.split(/\r?\n/);
  const fixtures: HybridaiSkillFixture[] = [];

  let state: SectionParseState | null = null;
  let mode: 'idle' | 'try-it' | 'conversation' = 'idle';

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const headingMatch = line.match(SKILLS_HEADING_RE);
    if (headingMatch) {
      state = {
        skill: headingMatch[1].toLowerCase(),
        conversationSeq: 0,
        promptSeq: 0,
      };
      mode = 'idle';
      continue;
    }
    if (!state) continue;

    if (line.trim() === '---') {
      state = null;
      mode = 'idle';
      continue;
    }

    const blockquote = stripBlockquote(line);
    if (blockquote === null) {
      if (line.trim() === '') continue;
      mode = 'idle';
      continue;
    }

    if (TRY_IT_YOURSELF_RE.test(blockquote)) {
      mode = 'try-it';
      continue;
    }
    if (CONVERSATION_FLOW_RE.test(blockquote)) {
      mode = 'conversation';
      state.conversationSeq += 1;
      continue;
    }
    if (mode === 'idle') continue;
    if (blockquote.trim() === '') continue;

    if (mode === 'try-it') {
      const promptMatch = blockquote.match(BACKTICK_PROMPT_RE);
      if (!promptMatch) continue;
      const prompt = promptMatch[1].trim();
      if (!prompt) continue;
      state.promptSeq += 1;
      fixtures.push(
        buildFixture({
          docFile,
          skill: state.skill,
          prompt,
          kind: 'try-it',
          index: state.promptSeq,
        }),
      );
      continue;
    }

    if (mode === 'conversation') {
      const promptMatch = blockquote.match(BACKTICK_PROMPT_RE);
      if (!promptMatch) continue;
      const inner = promptMatch[1].trim();
      const turnMatch = inner.match(CONVERSATION_TURN_RE);
      const prompt = turnMatch ? turnMatch[1].trim() : inner;
      if (!prompt) continue;
      const turnIndex = turnMatch ? Number.parseInt(turnMatch[0], 10) : null;
      state.promptSeq += 1;
      fixtures.push(
        buildFixture({
          docFile,
          skill: state.skill,
          prompt,
          kind: 'conversation',
          index: state.promptSeq,
          turnIndex: Number.isFinite(turnIndex ?? NaN)
            ? (turnIndex as number)
            : undefined,
          conversationId: `${state.skill}#conv${state.conversationSeq}`,
        }),
      );
    }
  }

  return fixtures;
}

function stripBlockquote(line: string): string | null {
  const match = line.match(/^\s*>\s?(.*)$/);
  return match ? match[1] : null;
}

function buildFixture(input: {
  docFile: string;
  skill: string;
  prompt: string;
  kind: HybridaiSkillFixtureKind;
  index: number;
  turnIndex?: number;
  conversationId?: string;
}): HybridaiSkillFixture {
  const explicit = promptNamesSkill(input.prompt, input.skill);
  return {
    id: `${input.docFile.replace(/\.md$/, '')}:${input.skill}:${input.kind}:${input.index}`,
    docFile: input.docFile,
    skill: input.skill,
    prompt: input.prompt,
    mode: explicit ? 'explicit' : 'implicit',
    kind: input.kind,
    turnIndex: input.turnIndex,
    conversationId: input.conversationId,
  };
}

function promptNamesSkill(prompt: string, skill: string): boolean {
  const lower = prompt.toLowerCase();
  const variants = [
    `/${skill}`,
    `/skill ${skill}`,
    `$${skill}`,
    ` ${skill} skill`,
  ];
  for (const variant of variants) {
    if (lower.includes(variant)) return true;
  }
  return false;
}

export function writeHybridaiSkillsFixtures(
  dataDir: string,
  set: HybridaiSkillFixtureSet,
): { fixturesPath: string; metaPath: string } {
  const installDir = resolveHybridaiSkillsInstallDir(dataDir);
  fs.mkdirSync(installDir, { recursive: true });
  const fixturesPath = getFixturesPath(dataDir);
  const metaPath = getFixturesMetaPath(dataDir);
  const jsonl =
    set.fixtures.map((fixture) => JSON.stringify(fixture)).join('\n') +
    (set.fixtures.length > 0 ? '\n' : '');
  fs.writeFileSync(fixturesPath, jsonl, 'utf8');
  const meta = {
    generatedAt: set.generatedAt,
    docsRoot: set.docsRoot,
    sourceFiles: set.sourceFiles,
    fixtureCount: set.fixtures.length,
  };
  fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return { fixturesPath, metaPath };
}

export function readHybridaiSkillsFixtures(
  dataDir: string,
): HybridaiSkillFixtureSet | null {
  const fixturesPath = getFixturesPath(dataDir);
  const metaPath = getFixturesMetaPath(dataDir);
  if (!fs.existsSync(fixturesPath) || !fs.existsSync(metaPath)) return null;
  const metaRaw = fs.readFileSync(metaPath, 'utf8');
  const meta = JSON.parse(metaRaw) as {
    generatedAt?: unknown;
    docsRoot?: unknown;
    sourceFiles?: unknown;
  };
  const jsonl = fs.readFileSync(fixturesPath, 'utf8');
  const fixtures: HybridaiSkillFixture[] = [];
  for (const rawLine of jsonl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    try {
      fixtures.push(JSON.parse(line) as HybridaiSkillFixture);
    } catch (error) {
      logger.warn(
        { error: (error as Error).message, line },
        'Failed to parse hybridai-skills fixture line',
      );
    }
  }
  return {
    generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : '',
    docsRoot: typeof meta.docsRoot === 'string' ? meta.docsRoot : '',
    sourceFiles: Array.isArray(meta.sourceFiles)
      ? meta.sourceFiles.filter(
          (entry): entry is string => typeof entry === 'string',
        )
      : [],
    fixtures,
  };
}

export function loadBundledSkillCatalogForGrader(installRoot: string): Skill[] {
  const skillsDir = path.join(installRoot, 'skills');
  if (!fs.existsSync(skillsDir)) return [];
  const entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const baseDir = path.join(skillsDir, entry.name);
    const filePath = path.join(baseDir, 'SKILL.md');
    if (!fs.existsSync(filePath)) continue;
    skills.push({
      name: entry.name,
      description: '',
      category: 'bundled',
      userInvocable: false,
      disableModelInvocation: false,
      always: false,
      requires: { bins: [], env: [] },
      metadata: {
        hybridclaw: {
          tags: [],
          relatedSkills: [],
          install: [],
        },
      },
      filePath,
      baseDir,
      source: 'bundled',
      location: `skills/${entry.name}/SKILL.md`,
    });
  }
  return skills;
}

export async function handleHybridaiSkillsCommand(params: {
  dataDir: string;
  env: HybridaiSkillsEvalEnvironment;
  workspaceModeExplicit?: boolean;
  subcommand?: string;
  args?: string[];
}): Promise<GatewayCommandResult> {
  const rawSub = String(params.subcommand || '')
    .trim()
    .toLowerCase();
  const sub = rawSub || 'help';
  const args = params.args ?? [];
  if (sub === 'help' || sub === '--help' || sub === '-h') {
    return infoResult(
      'hybridai-skills',
      renderHybridaiSkillsUsage(params.env, params.dataDir),
    );
  }
  switch (sub) {
    case 'setup':
      return handleSetup(params.dataDir);
    case 'list':
      return handleList(params.dataDir, args);
    case 'run':
      return await handleRun({
        dataDir: params.dataDir,
        env: params.env,
        workspaceModeExplicit: params.workspaceModeExplicit,
        args,
      });
    case 'results':
      return handleResults(params.dataDir);
    default:
      return errorResult(
        'hybridai-skills',
        `Unknown hybridai-skills command: \`${sub}\`.\n\n${renderHybridaiSkillsUsage(
          params.env,
          params.dataDir,
        )}`,
      );
  }
}

function handleSetup(dataDir: string): GatewayCommandResult {
  const docsRoot = resolveHybridaiSkillsDocsRoot();
  if (!fs.existsSync(docsRoot)) {
    return errorResult(
      'hybridai-skills setup',
      `Skills docs directory not found at \`${docsRoot}\`. Run from a HybridClaw install that ships \`docs/development/guides/skills/\`.`,
    );
  }
  const set = harvestHybridaiSkillsFixtures(docsRoot);
  const { fixturesPath, metaPath } = writeHybridaiSkillsFixtures(dataDir, set);
  const bySkill = new Map<string, number>();
  for (const fixture of set.fixtures) {
    bySkill.set(fixture.skill, (bySkill.get(fixture.skill) ?? 0) + 1);
  }
  const topSkills = Array.from(bySkill.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 12)
    .map(([skill, count]) => `- ${skill}: ${count}`);
  return infoResult(
    'hybridai-skills setup',
    [
      `Harvested ${set.fixtures.length} fixture(s) from ${set.sourceFiles.length} doc file(s).`,
      '',
      `Docs root: ${docsRoot}`,
      `Fixtures:  ${fixturesPath}`,
      `Meta:      ${metaPath}`,
      '',
      'Top skills by fixture count:',
      ...topSkills,
      '',
      'Next:',
      '- `/eval hybridai-skills list` to inspect fixtures.',
      '- `/eval hybridai-skills run --dry-run` to validate without calling the model.',
      '- `/eval hybridai-skills run --skill <name> --max 3` to run a small live sample.',
      '- `/eval hybridai-skills run` to run every fixture live (use `--max N` to cap).',
    ].join('\n'),
  );
}

function handleList(dataDir: string, rawArgs: string[]): GatewayCommandResult {
  const set = readHybridaiSkillsFixtures(dataDir);
  if (!set) {
    return errorResult(
      'hybridai-skills list',
      'No fixtures on disk. Run `/eval hybridai-skills setup` first.',
    );
  }
  const parsed = parseRunFlags(rawArgs);
  if (parsed.error) {
    return errorResult('hybridai-skills list', parsed.error);
  }
  const filtered = filterFixtures(set.fixtures, parsed);
  const lines = filtered
    .slice(0, parsed.max ?? 50)
    .map((fixture) => renderFixtureLine(fixture));
  const suffix =
    filtered.length > (parsed.max ?? 50)
      ? [
          '',
          `… ${filtered.length - (parsed.max ?? 50)} more not shown (use \`--max N\`).`,
        ]
      : [];
  return infoResult(
    'hybridai-skills list',
    [
      `Fixtures: ${filtered.length} of ${set.fixtures.length} total (generated ${set.generatedAt || '?'}).`,
      '',
      ...lines,
      ...suffix,
    ].join('\n'),
  );
}

function renderFixtureLine(fixture: HybridaiSkillFixture): string {
  const modeTag = fixture.mode === 'explicit' ? '[E]' : '[I]';
  const kindTag = fixture.kind === 'conversation' ? '[c]' : '   ';
  const truncated =
    fixture.prompt.length > 80
      ? `${fixture.prompt.slice(0, 77)}…`
      : fixture.prompt;
  return `- ${modeTag}${kindTag} ${fixture.skill.padEnd(20)}  ${truncated}`;
}

async function handleRun(params: {
  dataDir: string;
  env: HybridaiSkillsEvalEnvironment;
  workspaceModeExplicit?: boolean;
  args: string[];
}): Promise<GatewayCommandResult> {
  const set = readHybridaiSkillsFixtures(params.dataDir);
  if (!set) {
    return errorResult(
      'hybridai-skills run',
      'No fixtures on disk. Run `/eval hybridai-skills setup` first.',
    );
  }
  const parsed = parseRunFlags(params.args);
  if (parsed.error) {
    return errorResult('hybridai-skills run', parsed.error);
  }
  const filtered = filterFixtures(set.fixtures, parsed);
  if (filtered.length === 0) {
    return errorResult(
      'hybridai-skills run',
      'No fixtures match the given filters.',
    );
  }
  const capped = parsed.max ? filtered.slice(0, parsed.max) : filtered;
  const installRoot = resolveInstallRootSafe();
  const skills = loadBundledSkillCatalogForGrader(installRoot);
  const profile = resolveHybridaiSkillsRunProfile({
    baseProfile: params.env.profile,
    workspaceModeExplicit: params.workspaceModeExplicit,
    runFlags: parsed,
  });
  const models = resolveRequestedModels(params.env.baseModel, parsed.models);
  const startedAt = new Date().toISOString();
  const runs: HybridaiSkillsModelRunSummary[] = [];
  for (const model of models) {
    const profiledModel = encodeEvalProfileModel(model, profile);
    const modelStartedAt = new Date().toISOString();
    const results: FixtureGradeResult[] = [];
    for (const fixture of capped) {
      if (parsed.dryRun) {
        results.push(evaluateFixtureStatic(fixture, skills));
        continue;
      }
      try {
        results.push(
          await runFixtureLive(
            fixture,
            {
              baseUrl: params.env.baseUrl,
              apiKey: params.env.apiKey,
              model: profiledModel,
            },
            skills,
            params.dataDir,
            {
              forceExplicit: parsed.forceExplicit,
            },
          ),
        );
      } catch (error) {
        results.push({
          fixture,
          status: 'failed',
          observedSkill: null,
          toolNames: [],
          reason: `Error: ${(error as Error).message}`,
          durationMs: 0,
        });
      }
    }
    const modelFinishedAt = new Date().toISOString();
    runs.push({
      model,
      profiledModel,
      startedAt: modelStartedAt,
      finishedAt: modelFinishedAt,
      executedFixtures: results.length,
      passed: results.filter((result) => result.status === 'passed').length,
      failed: results.filter((result) => result.status === 'failed').length,
      skipped: results.filter((result) => result.status === 'skipped').length,
      results,
    });
  }
  const finishedAt = new Date().toISOString();
  const totals = summarizeHybridaiSkillsRuns(runs);
  const summary: HybridaiSkillsRunSummary = {
    startedAt,
    finishedAt,
    baseUrl: params.env.baseUrl,
    mode: parsed.dryRun ? 'dry-run' : 'live',
    totalFixtures: set.fixtures.length,
    profile,
    model: runs[0]?.model,
    executedFixtures: totals.executedFixtures,
    passed: totals.passed,
    failed: totals.failed,
    skipped: totals.skipped,
    filterSkill: parsed.skill,
    filterMode: parsed.mode,
    maxFixtures: parsed.max,
    forceExplicit: parsed.forceExplicit ? true : undefined,
    results: runs[0]?.results ?? [],
    runs,
  };
  writeLatestRun(params.dataDir, summary);
  return infoResult(
    `hybridai-skills Run (${summary.mode})`,
    renderRunSummary(summary, getLatestRunPath(params.dataDir)),
  );
}

function handleResults(dataDir: string): GatewayCommandResult {
  const runPath = getLatestRunPath(dataDir);
  if (!fs.existsSync(runPath)) {
    return errorResult(
      'hybridai-skills Results',
      'No prior run on disk. Run `/eval hybridai-skills run` first.',
    );
  }
  const summary = JSON.parse(
    fs.readFileSync(runPath, 'utf8'),
  ) as HybridaiSkillsRunSummary;
  return infoResult(
    'hybridai-skills Results',
    renderRunSummary(summary, runPath),
  );
}

interface ParsedRunFlags {
  dryRun: boolean;
  max?: number;
  skill?: string;
  mode?: HybridaiSkillFixtureMode;
  kind?: HybridaiSkillFixtureKind;
  forceExplicit?: boolean;
  models: string[];
  profile: EvalProfile;
  workspaceModeExplicit: boolean;
  error?: string;
}

function parseRunFlags(args: string[]): ParsedRunFlags {
  const parsed: ParsedRunFlags = {
    dryRun: false,
    models: [],
    profile: buildDefaultEvalProfile(),
    workspaceModeExplicit: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const raw = String(args[index] || '').trim();
    if (!raw) continue;
    if (raw === '--dry-run' || raw === '--dry') {
      parsed.dryRun = true;
      continue;
    }
    if (raw === '--live') {
      parsed.dryRun = false;
      continue;
    }
    if (raw === '--explicit') {
      parsed.forceExplicit = true;
      continue;
    }
    const [flagRaw, inlineValue] = splitFlag(raw);
    const flag = flagRaw.toLowerCase();
    if (flag === '--current-agent') {
      parsed.profile.workspaceMode = 'current-agent';
      parsed.workspaceModeExplicit = true;
      continue;
    }
    if (flag === '--fresh-agent') {
      parsed.profile.workspaceMode = 'fresh-agent';
      delete parsed.profile.agentId;
      parsed.workspaceModeExplicit = true;
      continue;
    }
    if (flag === '--ablate-system') {
      parsed.profile.ablateSystemPrompt = true;
      continue;
    }
    const value =
      inlineValue !== undefined ? inlineValue : (args[index + 1] ?? '');
    switch (flag) {
      case '--max': {
        const num = Number.parseInt(String(value).trim(), 10);
        if (!Number.isFinite(num) || num <= 0) {
          return { ...parsed, error: `Invalid --max: \`${value}\`.` };
        }
        parsed.max = num;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--skill': {
        const skill = String(value).trim().toLowerCase();
        if (!skill) {
          return { ...parsed, error: 'Expected a skill name after --skill.' };
        }
        parsed.skill = skill;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--mode': {
        const mode = String(value).trim().toLowerCase();
        if (mode !== 'implicit' && mode !== 'explicit') {
          return {
            ...parsed,
            error: 'Invalid --mode (expected `implicit` or `explicit`).',
          };
        }
        parsed.mode = mode;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--kind': {
        const kind = String(value).trim().toLowerCase();
        if (kind !== 'try-it' && kind !== 'conversation') {
          return {
            ...parsed,
            error: 'Invalid --kind (expected `try-it` or `conversation`).',
          };
        }
        parsed.kind = kind;
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--model': {
        const models = String(value)
          .split(',')
          .map((entry) => entry.trim())
          .filter(Boolean);
        if (models.length === 0) {
          return { ...parsed, error: 'Expected a model name after --model.' };
        }
        parsed.models.push(...models);
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--include-prompt': {
        const parts = String(value)
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
        if (parts.length === 0) {
          return {
            ...parsed,
            error: 'Expected at least one prompt part after --include-prompt.',
          };
        }
        const unknown = parts.find((part) => !isKnownEvalPromptPart(part));
        if (unknown) {
          return { ...parsed, error: `Unknown prompt part: \`${unknown}\`.` };
        }
        parsed.profile.includePromptParts.push(
          ...parts.filter((part) => isKnownEvalPromptPart(part)),
        );
        if (inlineValue === undefined) index += 1;
        break;
      }
      case '--omit-prompt': {
        const parts = String(value)
          .split(',')
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean);
        if (parts.length === 0) {
          return {
            ...parsed,
            error: 'Expected at least one prompt part after --omit-prompt.',
          };
        }
        const unknown = parts.find((part) => !isKnownEvalPromptPart(part));
        if (unknown) {
          return { ...parsed, error: `Unknown prompt part: \`${unknown}\`.` };
        }
        parsed.profile.omitPromptParts.push(
          ...parts.filter((part) => isKnownEvalPromptPart(part)),
        );
        if (inlineValue === undefined) index += 1;
        break;
      }
      default:
        return { ...parsed, error: `Unknown flag: \`${raw}\`.` };
    }
  }
  parsed.profile.includePromptParts = Array.from(
    new Set(parsed.profile.includePromptParts),
  );
  parsed.profile.omitPromptParts = Array.from(
    new Set(parsed.profile.omitPromptParts),
  );
  parsed.models = Array.from(new Set(parsed.models));
  return parsed;
}

function splitFlag(raw: string): [string, string | undefined] {
  const eq = raw.indexOf('=');
  if (eq === -1) return [raw, undefined];
  return [raw.slice(0, eq), raw.slice(eq + 1)];
}

function filterFixtures(
  fixtures: HybridaiSkillFixture[],
  filters: ParsedRunFlags,
): HybridaiSkillFixture[] {
  return fixtures.filter((fixture) => {
    if (filters.skill && fixture.skill !== filters.skill) return false;
    if (filters.mode && fixture.mode !== filters.mode) return false;
    if (filters.kind && fixture.kind !== filters.kind) return false;
    return true;
  });
}

function evaluateFixtureStatic(
  fixture: HybridaiSkillFixture,
  skills: Skill[],
): FixtureGradeResult {
  const skillExists = skills.some((skill) => skill.name === fixture.skill);
  if (!skillExists) {
    return {
      fixture,
      status: 'failed',
      observedSkill: null,
      toolNames: [],
      reason: `Expected skill \`${fixture.skill}\` is not installed.`,
      durationMs: 0,
    };
  }
  if (fixture.mode === 'explicit') {
    return {
      fixture,
      status: 'passed',
      observedSkill: fixture.skill,
      toolNames: [],
      reason:
        'explicit prompt references the skill; live run required to verify execution',
      durationMs: 0,
    };
  }
  return {
    fixture,
    status: 'skipped',
    observedSkill: null,
    toolNames: [],
    reason: 'dry-run cannot verify implicit skill selection; use --live',
    durationMs: 0,
  };
}

async function runFixtureLive(
  fixture: HybridaiSkillFixture,
  env: Pick<HybridaiSkillsEvalEnvironment, 'baseUrl' | 'apiKey' | 'model'>,
  skills: Skill[],
  dataDir: string,
  options: { forceExplicit?: boolean } = {},
): Promise<FixtureGradeResult> {
  const start = Date.now();
  const endpoint = `${env.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const prompt = options.forceExplicit
    ? `/${fixture.skill} ${fixture.prompt}`
    : fixture.prompt;
  const body = {
    model: env.model,
    messages: [{ role: 'user', content: prompt }],
    stream: false,
  };
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${env.apiKey}`,
    },
    body: JSON.stringify(body),
  });
  const durationMs = Date.now() - start;
  const sessionId =
    response.headers.get('x-hybridclaw-session-id') || undefined;
  const auditPath = sessionId
    ? resolveAuditWirePath(dataDir, sessionId)
    : undefined;
  if (!response.ok) {
    const errorText = await safeReadText(response);
    return {
      fixture,
      status: 'failed',
      observedSkill: null,
      toolNames: [],
      sessionId,
      auditPath,
      reason: `HTTP ${response.status}: ${errorText.slice(0, 200)}`,
      durationMs,
    };
  }
  const payload = (await response.json()) as unknown;
  const parsed = parseChatCompletion(payload);
  const auditTrace =
    sessionId && auditPath ? readAuditTrace(auditPath, skills) : null;
  // Grade from the executed trace whenever it exists. The audit log is the
  // authoritative source for real gateway tool execution and skill observation.
  const toolExecutions = auditTrace?.toolExecutions ?? parsed.toolExecutions;
  const observedSkill =
    auditTrace?.observedSkill ??
    resolveObservedSkillName({
      skills,
      toolExecutions,
    });
  const toolNames = toolExecutions.map((exec) => exec.name);
  const expected = fixture.skill;
  if (observedSkill === expected) {
    return {
      fixture,
      status: 'passed',
      observedSkill,
      toolNames,
      sessionId,
      auditPath,
      observationSource: auditTrace?.observationSource ?? 'response',
      durationMs,
      assistantPreview: parsed.assistantPreview,
    };
  }
  return {
    fixture,
    status: 'failed',
    observedSkill,
    toolNames,
    sessionId,
    auditPath,
    observationSource: auditTrace?.observationSource ?? 'response',
    reason: observedSkill
      ? `observed skill \`${observedSkill}\`, expected \`${expected}\``
      : 'no skill observed in tool trace',
    durationMs,
    assistantPreview: parsed.assistantPreview,
  };
}

interface ParsedChatCompletion {
  toolExecutions: ToolExecution[];
  assistantPreview?: string;
}

interface ParsedAuditTrace {
  observedSkill: string | null;
  toolExecutions: ToolExecution[];
  observationSource: 'audit.skill.execution' | 'audit.tool.trace';
}

function parseChatCompletion(payload: unknown): ParsedChatCompletion {
  if (!isRecord(payload)) return { toolExecutions: [] };
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  const toolExecutions: ToolExecution[] = [];
  let assistantPreview: string | undefined;
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const message = isRecord(choice.message) ? choice.message : null;
    if (!message) continue;
    if (!assistantPreview && typeof message.content === 'string') {
      assistantPreview = message.content.slice(0, 240);
    }
    const toolCalls = Array.isArray(message.tool_calls)
      ? message.tool_calls
      : [];
    for (const call of toolCalls) {
      if (!isRecord(call)) continue;
      const fn = isRecord(call.function) ? call.function : null;
      const name =
        (fn && typeof fn.name === 'string' && fn.name) ||
        (typeof call.name === 'string' ? call.name : '') ||
        'tool';
      const args =
        (fn && typeof fn.arguments === 'string' && fn.arguments) ||
        (typeof call.arguments === 'string' ? call.arguments : '') ||
        '{}';
      toolExecutions.push({
        name,
        arguments: args,
        result: '',
        durationMs: 0,
      });
    }
  }
  return { toolExecutions, assistantPreview };
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function resolveHybridaiSkillsRunProfile(params: {
  baseProfile: EvalProfile;
  workspaceModeExplicit?: boolean;
  runFlags: ParsedRunFlags;
}): EvalProfile {
  const profile: EvalProfile = {
    ...params.baseProfile,
    includePromptParts: [...params.baseProfile.includePromptParts],
    omitPromptParts: [...params.baseProfile.omitPromptParts],
  };

  if (!params.workspaceModeExplicit && !params.runFlags.workspaceModeExplicit) {
    profile.workspaceMode = 'fresh-agent';
    delete profile.agentId;
  }

  if (params.runFlags.workspaceModeExplicit) {
    profile.workspaceMode = params.runFlags.profile.workspaceMode;
    if (profile.workspaceMode === 'fresh-agent') {
      delete profile.agentId;
    }
  }

  if (params.runFlags.profile.ablateSystemPrompt) {
    profile.ablateSystemPrompt = true;
  }

  profile.includePromptParts = Array.from(
    new Set([
      ...profile.includePromptParts,
      ...params.runFlags.profile.includePromptParts,
    ]),
  );
  profile.omitPromptParts = Array.from(
    new Set([
      ...profile.omitPromptParts,
      ...params.runFlags.profile.omitPromptParts,
    ]),
  );

  return profile;
}

function resolveRequestedModels(
  baseModel: string,
  requestedModels: string[],
): string[] {
  const models = requestedModels.length > 0 ? requestedModels : [baseModel];
  return Array.from(
    new Set(models.map((entry) => entry.trim()).filter(Boolean)),
  );
}

function summarizeHybridaiSkillsRuns(runs: HybridaiSkillsModelRunSummary[]): {
  executedFixtures: number;
  passed: number;
  failed: number;
  skipped: number;
} {
  return runs.reduce(
    (totals, run) => ({
      executedFixtures: totals.executedFixtures + run.executedFixtures,
      passed: totals.passed + run.passed,
      failed: totals.failed + run.failed,
      skipped: totals.skipped + run.skipped,
    }),
    { executedFixtures: 0, passed: 0, failed: 0, skipped: 0 },
  );
}

function resolveAuditWirePath(dataDir: string, sessionId: string): string {
  const safeSessionDir =
    sessionId.trim().replace(/[^a-zA-Z0-9_-]/g, '_') || 'session';
  return path.join(dataDir, 'audit', safeSessionDir, 'wire.jsonl');
}

function readAuditTrace(
  filePath: string,
  skills: Skill[],
): ParsedAuditTrace | null {
  if (!fs.existsSync(filePath)) return null;
  const lines = fs
    .readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length === 0) return null;

  const toolExecutions = new Map<string, ToolExecution>();
  const toolOrder: string[] = [];
  let observedSkill: string | null = null;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(parsed) || !isRecord(parsed.event)) continue;
    const event = parsed.event;
    const eventType =
      typeof event.type === 'string' ? event.type.trim().toLowerCase() : '';
    if (eventType === 'tool.call') {
      const toolCallId =
        typeof event.toolCallId === 'string' ? event.toolCallId : '';
      if (!toolCallId) continue;
      toolOrder.push(toolCallId);
      toolExecutions.set(toolCallId, {
        name: typeof event.toolName === 'string' ? event.toolName : 'tool',
        arguments: JSON.stringify(event.arguments ?? {}),
        result: '',
        durationMs: 0,
      });
      continue;
    }
    if (eventType === 'tool.result') {
      const toolCallId =
        typeof event.toolCallId === 'string' ? event.toolCallId : '';
      const execution = (toolCallId && toolExecutions.get(toolCallId)) || {
        name: typeof event.toolName === 'string' ? event.toolName : 'tool',
        arguments: '{}',
        result: '',
        durationMs: 0,
      };
      execution.name =
        typeof event.toolName === 'string' ? event.toolName : execution.name;
      execution.result =
        typeof event.resultSummary === 'string' ? event.resultSummary : '';
      execution.durationMs =
        typeof event.durationMs === 'number' &&
        Number.isFinite(event.durationMs)
          ? event.durationMs
          : 0;
      execution.isError = event.isError === true;
      execution.blocked = event.blocked === true;
      if (toolCallId) {
        if (!toolExecutions.has(toolCallId)) toolOrder.push(toolCallId);
        toolExecutions.set(toolCallId, execution);
      }
      continue;
    }
    if (eventType === 'skill.execution') {
      observedSkill =
        typeof event.skillName === 'string'
          ? event.skillName.trim()
          : observedSkill;
    }
  }

  const orderedExecutions = toolOrder
    .map((toolCallId) => toolExecutions.get(toolCallId))
    .filter((execution): execution is ToolExecution => execution != null);

  if (orderedExecutions.length === 0 && !observedSkill) {
    return null;
  }

  return {
    observedSkill:
      observedSkill ||
      resolveObservedSkillName({
        skills,
        toolExecutions: orderedExecutions,
      }),
    toolExecutions: orderedExecutions,
    observationSource: observedSkill
      ? 'audit.skill.execution'
      : 'audit.tool.trace',
  };
}

function writeLatestRun(
  dataDir: string,
  summary: HybridaiSkillsRunSummary,
): void {
  const installDir = resolveHybridaiSkillsInstallDir(dataDir);
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(
    getLatestRunPath(dataDir),
    `${JSON.stringify(summary, null, 2)}\n`,
    'utf8',
  );
}

function renderRunSummary(
  summary: HybridaiSkillsRunSummary,
  runPath?: string,
): string {
  const runs = normalizeModelRuns(summary);
  const profile = summary.profile ?? buildDefaultEvalProfile();
  const filterLines: string[] = [];
  if (summary.filterSkill) filterLines.push(`skill=${summary.filterSkill}`);
  if (summary.filterMode) filterLines.push(`mode=${summary.filterMode}`);
  if (summary.maxFixtures) filterLines.push(`max=${summary.maxFixtures}`);
  if (summary.forceExplicit) filterLines.push('explicit');
  const totals = summarizeHybridaiSkillsRuns(runs);
  const executed = totals.executedFixtures;
  const totalExecutionSlots = summary.totalFixtures * Math.max(1, runs.length);
  const gradable = totals.passed + totals.failed;
  const score = gradable > 0 ? totals.passed / gradable : null;
  const startedMs = Date.parse(summary.startedAt);
  const finishedMs = Date.parse(summary.finishedAt);
  const durationMs =
    Number.isFinite(startedMs) && Number.isFinite(finishedMs)
      ? Math.max(0, finishedMs - startedMs)
      : null;

  const overviewSection = renderKeyValueSection('Overview', [
    [
      'Evaluated model',
      runs.length <= 1
        ? (runs[0]?.model ?? summary.model ?? '?')
        : `${runs.length} models`,
    ],
    ['Harness', `HybridClaw v${resolveHarnessVersion()}`],
    ['Status', summary.mode === 'dry-run' ? 'dry-run' : 'completed'],
    ['Base URL', summary.baseUrl],
    ['Filters', filterLines.length ? filterLines.join(', ') : 'none'],
  ]);
  const profileSection = renderKeyValueSection(
    'Profile',
    describeEvalProfile(profile).map((entry) => {
      const [label, value] = entry.split(':', 2);
      return [label, value?.trim() || null] as const;
    }),
  );
  const resultsSection = renderKeyValueSection('Results', [
    ['Score', score != null ? score.toFixed(3) : 'n/a'],
    [
      'Passed',
      gradable > 0
        ? `${totals.passed}/${gradable} (${Math.round((score ?? 0) * 100)}%)`
        : `${totals.passed}`,
    ],
    ['Failed', totals.failed],
    ['Skipped', totals.skipped],
    ['Executed', `${executed}/${totalExecutionSlots}`],
  ]);
  const runSection = renderKeyValueSection('Run', [
    ['Mode', summary.mode],
    ['Started', summary.startedAt],
    ['Finished', summary.finishedAt],
    ['Duration', durationMs != null ? formatDuration(durationMs) : null],
  ]);
  const pathsSection = renderKeyValueSection('Paths', [
    ['Latest run', runPath || null],
  ]);

  const comparisonSection =
    runs.length > 1
      ? renderKeyValueSection(
          'Comparison',
          runs.map((run) => {
            const runGradable = run.passed + run.failed;
            const runScore =
              runGradable > 0 ? (run.passed / runGradable).toFixed(3) : 'n/a';
            const runStartedMs = Date.parse(run.startedAt);
            const runFinishedMs = Date.parse(run.finishedAt);
            const runDuration =
              Number.isFinite(runStartedMs) && Number.isFinite(runFinishedMs)
                ? formatDuration(Math.max(0, runFinishedMs - runStartedMs))
                : null;
            return [
              run.model,
              [
                `score ${runScore}`,
                `passed ${run.passed}/${runGradable || run.executedFixtures}`,
                `failed ${run.failed}`,
                `skipped ${run.skipped}`,
                runDuration ? `duration ${runDuration}` : null,
              ]
                .filter(Boolean)
                .join(' · '),
            ] as const;
          }),
        )
      : '';

  const failures = runs.flatMap((run) =>
    run.results
      .filter((result) => result.status === 'failed')
      .map((result) => ({ run, result })),
  );
  const failuresSection =
    failures.length > 0
      ? renderKeyValueSection(
          'Failures',
          failures.map(
            ({ run, result }) =>
              [
                runs.length > 1
                  ? `${run.model} · ${result.fixture.id}`
                  : result.fixture.id,
                describeFailure(result),
              ] as const,
          ),
        )
      : '';

  const passes = runs.flatMap((run) =>
    run.results
      .filter((result) => result.status === 'passed')
      .map((result) => ({ run, result })),
  );
  const passesSection =
    passes.length > 0
      ? renderKeyValueSection(
          'Passes',
          passes.map(
            ({ run, result }) =>
              [
                runs.length > 1
                  ? `${run.model} · ${result.fixture.id}`
                  : result.fixture.id,
                result.toolNames.length > 0
                  ? result.toolNames.join(',')
                  : (result.observedSkill ?? 'ok'),
              ] as const,
          ),
        )
      : '';

  return joinSections([
    overviewSection,
    profileSection,
    resultsSection,
    comparisonSection,
    runSection,
    pathsSection,
    failuresSection,
    passesSection,
  ]);
}

function describeFailure(result: FixtureGradeResult): string {
  const parts: string[] = [];
  if (result.reason) parts.push(result.reason);
  if (
    result.observedSkill &&
    result.observedSkill !== result.fixture.skill &&
    !(result.reason || '').includes(result.observedSkill)
  ) {
    parts.push(`observed=${result.observedSkill}`);
  }
  if (result.toolNames.length > 0) {
    parts.push(`tools=${result.toolNames.join(',')}`);
  }
  if (result.sessionId) {
    parts.push(`session=${result.sessionId}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'failed';
}

function normalizeModelRuns(
  summary: HybridaiSkillsRunSummary,
): HybridaiSkillsModelRunSummary[] {
  if (Array.isArray(summary.runs) && summary.runs.length > 0) {
    return summary.runs;
  }
  return [
    {
      model: summary.model || '?',
      profiledModel: summary.model || '?',
      startedAt: summary.startedAt,
      finishedAt: summary.finishedAt,
      executedFixtures:
        summary.executedFixtures ?? summary.results?.length ?? 0,
      passed: summary.passed ?? 0,
      failed: summary.failed ?? 0,
      skipped: summary.skipped ?? 0,
      results: summary.results ?? [],
    },
  ];
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m${seconds.toString().padStart(2, '0')}s`;
}

function renderHybridaiSkillsUsage(
  env: HybridaiSkillsEvalEnvironment,
  dataDir: string,
): string {
  const fixturesPath = getFixturesPath(dataDir);
  const installed = fs.existsSync(fixturesPath);
  return [
    'Evaluate documented skill-trigger prompts against HybridClaw.',
    '',
    'Usage:',
    '- `/eval hybridai-skills setup`',
    '- `/eval hybridai-skills list [--skill <name>] [--mode implicit|explicit] [--kind try-it|conversation] [--max N]`',
    '- `/eval hybridai-skills run [--dry-run|--live] [--skill <name>] [--mode ...] [--kind ...] [--max N] [--explicit] [--model <name>[,<name>]] [--current-agent|--fresh-agent] [--ablate-system] [--include-prompt=<parts>] [--omit-prompt=<parts>]`',
    '- `/eval hybridai-skills results`',
    '',
    'What it does:',
    '- `setup` harvests the "Try it yourself" prompts from `docs/development/guides/skills/*.md` into a JSONL fixture set.',
    '- `run --dry-run` validates fixtures without calling the model (checks explicit-name references and skill existence).',
    '- `run` (default `--live`, runs all matching fixtures unless `--max N` is set) posts each fixture to the local HybridClaw OpenAI endpoint and grades from the session audit trace when available.',
    '- `run --explicit` prefixes each prompt with `/<skill>` so the model is forced to invoke the named skill (useful for isolating skill-execution failures from skill-trigger failures).',
    '- `run` defaults to a fresh temporary agent workspace per fixture unless you pass `--current-agent` or already selected a workspace mode explicitly at the `/eval` level.',
    '- Repeat `--model` or use a comma-separated list to compare multiple models in one run.',
    '',
    `Fixtures path: ${fixturesPath}${installed ? ' (present)' : ' (missing — run setup)'}`,
    `Base URL:      ${env.baseUrl}`,
    `Base model:    ${env.baseModel}`,
    `Eval model:    ${env.model}`,
  ].join('\n');
}

function infoResult(title: string, text: string): GatewayCommandResult {
  return { kind: 'info', title, text };
}

function errorResult(title: string, text: string): GatewayCommandResult {
  return { kind: 'error', title, text };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveInstallRootSafe(): string {
  try {
    return resolveInstallPath();
  } catch {
    return process.cwd();
  }
}
