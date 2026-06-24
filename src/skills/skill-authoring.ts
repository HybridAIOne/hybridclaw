import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../agent/agent.js';
import { DATA_DIR, HYBRIDAI_CHATBOT_ID } from '../config/config.js';
import { DEFAULT_RUNTIME_HOME_DIR } from '../config/runtime-paths.js';
import { resolveManagedCommunitySkillsDir } from './skills.js';
import { guardSkillDirectory, type SkillGuardFinding } from './skills-guard.js';

const MAX_SOURCE_CHARS = 80_000;
const MAX_SOURCE_FILES = 16;
const MAX_FILE_CHARS = 12_000;
const TEXT_EXTENSIONS = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.log',
  '.md',
  '.mjs',
  '.py',
  '.sh',
  '.ts',
  '.txt',
  '.yaml',
  '.yml',
]);
const SKIPPED_DIRS = new Set([
  '.git',
  '.next',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'vendor',
]);

export class SkillDraftInputError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'SkillDraftInputError';
  }
}

export interface SkillFileDraft {
  path: string;
  content: string;
}

export interface ManagedSkillDraft {
  name: string;
  description: string;
  category?: string;
  shortDescription?: string;
  userInvocable?: boolean;
  disableModelInvocation?: boolean;
  tags?: string[];
  body: string;
  files?: SkillFileDraft[];
}

export interface SkillSourceExcerpt {
  title: string;
  origin: string;
  content: string;
}

export interface SkillCreationProposal {
  id: string;
  status: 'staged' | 'applied' | 'rejected';
  createdAt: string;
  updatedAt: string;
  appliedAt: string | null;
  rejectedAt: string | null;
  agentId: string;
  sourceDescription: string;
  sourceKind: 'notes' | 'path' | 'url';
  focus: string;
  draft: ManagedSkillDraft;
  packageDir: string;
  guard: {
    allowed: boolean;
    reason: string;
    verdict: string;
    findingsCount: number;
    findings: SkillGuardFinding[];
  };
  appliedSkillDir?: string;
}

interface CollectedSkillSource {
  kind: SkillCreationProposal['sourceKind'];
  label: string;
  focus: string;
  excerpts: SkillSourceExcerpt[];
}

interface ParsedAuthoringOutput {
  name?: unknown;
  description?: unknown;
  category?: unknown;
  shortDescription?: unknown;
  short_description?: unknown;
  tags?: unknown;
  body?: unknown;
  files?: unknown;
}

function normalizeSkillSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function normalizeCreatedSkillCategory(raw: string | undefined): string {
  const normalized = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'uncategorized';
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function assertNonEmptySkillName(name: string): void {
  if (!name) {
    throw new SkillDraftInputError(400, 'Expected non-empty skill `name`.');
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new SkillDraftInputError(
      400,
      'Skill name must be lowercase alphanumeric with hyphens (e.g. "my-skill").',
    );
  }
  if (name.length > 64) {
    throw new SkillDraftInputError(
      400,
      'Skill name must be 64 characters or fewer.',
    );
  }
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }
  return [];
}

function normalizeGeneratedFiles(value: unknown): SkillFileDraft[] {
  if (!Array.isArray(value)) return [];
  const files: SkillFileDraft[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const filePath = String(record.path || '').trim();
    if (!filePath) continue;
    files.push({
      path: filePath,
      content: String(record.content || ''),
    });
  }
  return files;
}

function validateAndResolveFiles(
  skillDir: string,
  files: SkillFileDraft[] | undefined,
): Array<{ relativePath: string; content: string }> {
  const resolvedFiles: Array<{ relativePath: string; content: string }> = [];
  for (const file of files ?? []) {
    const filePath = String(file.path || '').trim();
    if (!filePath) {
      throw new SkillDraftInputError(
        400,
        'Skill file paths must be non-empty and include a filename.',
      );
    }
    if (filePath.endsWith('/') || filePath.endsWith(path.sep)) {
      throw new SkillDraftInputError(
        400,
        `File path \`${filePath}\` must include a filename.`,
      );
    }
    const resolved = path.resolve(skillDir, filePath);
    if (!pathWithin(skillDir, resolved) || resolved === skillDir) {
      throw new SkillDraftInputError(
        400,
        `File path \`${filePath}\` escapes the skill directory.`,
      );
    }
    resolvedFiles.push({
      relativePath: path.relative(skillDir, resolved),
      content: file.content || '',
    });
  }
  return resolvedFiles;
}

export function buildSkillContentFromDraft(input: ManagedSkillDraft): string {
  const name = String(input.name || '').trim();
  assertNonEmptySkillName(name);
  const description = String(input.description || '').trim();
  if (!description) {
    throw new SkillDraftInputError(
      400,
      'Expected non-empty skill `description`.',
    );
  }
  const category = normalizeCreatedSkillCategory(input.category);
  const shortDescription = String(input.shortDescription || '').trim();
  const tags = Array.isArray(input.tags) ? input.tags : [];
  const userInvocable =
    input.userInvocable !== undefined ? input.userInvocable : true;
  const disableModelInvocation =
    input.disableModelInvocation !== undefined
      ? input.disableModelInvocation
      : false;

  const frontmatterLines = [
    '---',
    `name: ${name}`,
    `description: ${yamlString(description)}`,
    `user-invocable: ${userInvocable}`,
    `disable-model-invocation: ${disableModelInvocation}`,
  ];
  if (category || shortDescription || tags.length > 0) {
    frontmatterLines.push('metadata:');
    frontmatterLines.push('  hybridclaw:');
    frontmatterLines.push(`    category: ${yamlString(category)}`);
    if (shortDescription) {
      frontmatterLines.push(
        `    short_description: ${yamlString(shortDescription)}`,
      );
    }
    if (tags.length > 0) {
      frontmatterLines.push('    tags:');
      for (const tag of tags) {
        frontmatterLines.push(`      - ${yamlString(String(tag))}`);
      }
    }
  }
  frontmatterLines.push('---');

  const body = String(input.body || '').trim();
  if (!body) {
    throw new SkillDraftInputError(400, 'Expected non-empty skill body.');
  }
  return `${frontmatterLines.join('\n')}\n\n${body}\n`;
}

function writeSkillPackage(params: {
  skillDir: string;
  draft: ManagedSkillDraft;
}): void {
  const content = buildSkillContentFromDraft(params.draft);
  const resolvedFiles = validateAndResolveFiles(
    params.skillDir,
    params.draft.files,
  );
  fs.mkdirSync(params.skillDir, { recursive: true });
  fs.writeFileSync(path.join(params.skillDir, 'SKILL.md'), content, 'utf-8');
  for (const file of resolvedFiles) {
    const targetPath = path.join(params.skillDir, file.relativePath);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, file.content, 'utf-8');
  }
}

export function createManagedSkillFromDraft(
  input: ManagedSkillDraft & { homeDir?: string },
): { skillName: string; skillDir: string } {
  const name = String(input.name || '').trim();
  assertNonEmptySkillName(name);

  const projectSkillsDir = resolveManagedCommunitySkillsDir(
    input.homeDir || DEFAULT_RUNTIME_HOME_DIR,
  );
  const skillDir = path.join(projectSkillsDir, name);
  if (fs.existsSync(skillDir)) {
    throw new SkillDraftInputError(
      409,
      `Skill \`${name}\` already exists at ${skillDir}.`,
    );
  }

  fs.mkdirSync(projectSkillsDir, { recursive: true });
  const stagedSkillDir = fs.mkdtempSync(
    path.join(projectSkillsDir, `.${name}.create-`),
  );
  try {
    writeSkillPackage({ skillDir: stagedSkillDir, draft: input });
    const guardDecision = guardSkillDirectory({
      skillName: name,
      skillPath: stagedSkillDir,
      sourceTag: 'workspace',
    });
    if (!guardDecision.allowed) {
      throw new SkillDraftInputError(
        400,
        `Skill \`${name}\` was blocked by the security scanner: ${guardDecision.reason}.`,
      );
    }
    try {
      fs.renameSync(stagedSkillDir, skillDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        fs.existsSync(skillDir)
      ) {
        throw new SkillDraftInputError(
          409,
          `Skill \`${name}\` already exists at ${skillDir}.`,
        );
      }
      throw error;
    }
  } catch (error) {
    fs.rmSync(stagedSkillDir, { recursive: true, force: true });
    throw error;
  }

  return { skillName: name, skillDir };
}

function isProbablyText(content: Buffer): boolean {
  if (content.includes(0)) return false;
  let suspicious = 0;
  for (const byte of content.subarray(0, Math.min(content.length, 4096))) {
    if (byte < 9 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious === 0 || suspicious / Math.min(content.length, 4096) < 0.05;
}

function readTextFileExcerpt(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && !TEXT_EXTENSIONS.has(ext)) return null;
  const buffer = fs.readFileSync(filePath);
  if (!isProbablyText(buffer)) return null;
  const text = buffer.toString('utf-8');
  return text.length > MAX_FILE_CHARS
    ? `${text.slice(0, MAX_FILE_CHARS)}\n\n[truncated]`
    : text;
}

function collectFilesFromDirectory(root: string): string[] {
  const files: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [
    { dir: root, depth: 0 },
  ];
  while (queue.length > 0 && files.length < MAX_SOURCE_FILES) {
    const current = queue.shift();
    if (!current) break;
    if (current.depth > 3) continue;
    const entries = fs
      .readdirSync(current.dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (files.length >= MAX_SOURCE_FILES) break;
      if (entry.isDirectory()) {
        if (SKIPPED_DIRS.has(entry.name)) continue;
        queue.push({
          dir: path.join(current.dir, entry.name),
          depth: current.depth + 1,
        });
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(path.join(current.dir, entry.name));
    }
  }
  return files;
}

function splitFirstToken(value: string): { token: string; rest: string } {
  const trimmed = value.trim();
  const match = trimmed.match(/^"([^"]+)"(?:\s+([\s\S]*))?$/);
  if (match) {
    return { token: match[1] || '', rest: (match[2] || '').trim() };
  }
  const spaceIndex = trimmed.indexOf(' ');
  if (spaceIndex === -1) return { token: trimmed, rest: '' };
  return {
    token: trimmed.slice(0, spaceIndex),
    rest: trimmed.slice(spaceIndex + 1).trim(),
  };
}

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith(`~${path.sep}`)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function collectUrlSource(
  url: string,
  focus: string,
): Promise<CollectedSkillSource> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new SkillDraftInputError(
      400,
      `Failed to fetch ${url}: HTTP ${response.status}`,
    );
  }
  const contentType = response.headers.get('content-type') || '';
  const text = await response.text();
  return {
    kind: 'url',
    label: url,
    focus,
    excerpts: [
      {
        title: `URL: ${url}`,
        origin: contentType || 'unknown content type',
        content:
          text.length > MAX_SOURCE_CHARS
            ? `${text.slice(0, MAX_SOURCE_CHARS)}\n\n[truncated]`
            : text,
      },
    ],
  };
}

function collectPathSource(
  sourcePath: string,
  focus: string,
): CollectedSkillSource {
  const resolved = path.resolve(expandHome(sourcePath));
  if (!fs.existsSync(resolved)) {
    throw new SkillDraftInputError(400, `Source path not found: ${sourcePath}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    const content = readTextFileExcerpt(resolved);
    if (!content) {
      throw new SkillDraftInputError(
        400,
        `Source file is not a supported text file: ${sourcePath}`,
      );
    }
    return {
      kind: 'path',
      label: resolved,
      focus,
      excerpts: [
        {
          title: path.basename(resolved),
          origin: resolved,
          content,
        },
      ],
    };
  }
  if (!stat.isDirectory()) {
    throw new SkillDraftInputError(
      400,
      `Source path must be a file or directory: ${sourcePath}`,
    );
  }

  const excerpts: SkillSourceExcerpt[] = [];
  for (const filePath of collectFilesFromDirectory(resolved)) {
    const content = readTextFileExcerpt(filePath);
    if (!content) continue;
    excerpts.push({
      title: path.relative(resolved, filePath),
      origin: filePath,
      content,
    });
    if (excerpts.length >= MAX_SOURCE_FILES) break;
  }
  if (excerpts.length === 0) {
    throw new SkillDraftInputError(
      400,
      `No supported text files found under source directory: ${sourcePath}`,
    );
  }
  return {
    kind: 'path',
    label: resolved,
    focus,
    excerpts,
  };
}

async function collectSourceMaterial(
  sourceDescription: string,
): Promise<CollectedSkillSource> {
  const trimmed = sourceDescription.trim();
  if (!trimmed) {
    throw new SkillDraftInputError(
      400,
      'Expected source material to learn from.',
    );
  }
  const { token, rest } = splitFirstToken(trimmed);
  if (isHttpUrl(token)) {
    return await collectUrlSource(token, rest);
  }
  if (fs.existsSync(path.resolve(expandHome(trimmed)))) {
    return collectPathSource(trimmed, '');
  }
  if (token && fs.existsSync(path.resolve(expandHome(token)))) {
    return collectPathSource(token, rest);
  }
  return {
    kind: 'notes',
    label: 'inline notes',
    focus: '',
    excerpts: [
      {
        title: 'Inline notes',
        origin: 'operator-provided text',
        content:
          trimmed.length > MAX_SOURCE_CHARS
            ? `${trimmed.slice(0, MAX_SOURCE_CHARS)}\n\n[truncated]`
            : trimmed,
      },
    ],
  };
}

function sourceDigest(source: CollectedSkillSource): string {
  const hash = createHash('sha256');
  hash.update(source.kind);
  hash.update(source.label);
  hash.update(source.focus);
  for (const excerpt of source.excerpts) {
    hash.update(excerpt.origin);
    hash.update(excerpt.content);
  }
  return hash.digest('hex');
}

function buildSourceReference(source: CollectedSkillSource): string {
  const lines = [
    '# Learned Sources',
    '',
    `Source: ${source.label}`,
    `Kind: ${source.kind}`,
    source.focus ? `Focus: ${source.focus}` : '',
    `Digest: ${sourceDigest(source)}`,
    '',
    'This file records the source material used to create the skill proposal.',
    'Review the generated SKILL.md against these notes before applying.',
    '',
  ].filter(Boolean);
  for (const excerpt of source.excerpts) {
    lines.push(`## ${excerpt.title}`, '', `Origin: ${excerpt.origin}`, '');
    lines.push(excerpt.content.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function buildSkillAuthoringPrompt(input: {
  source: CollectedSkillSource;
  suggestedName?: string;
  category?: string;
}): string {
  const sourceBlocks = input.source.excerpts.map((excerpt, index) =>
    [
      `### Source ${index + 1}: ${excerpt.title}`,
      `Origin: ${excerpt.origin}`,
      '',
      excerpt.content,
    ].join('\n'),
  );
  return [
    'Turn the following source material into one reusable HybridClaw Agent Skill.',
    'Return JSON only. Do not include Markdown fences or prose outside JSON.',
    'The JSON shape must be: {"name":"lowercase-hyphen-skill","description":"...","category":"development|productivity|business|office|misc|uncategorized","shortDescription":"...","tags":["..."],"body":"Markdown body without YAML frontmatter","files":[{"path":"references/source-summary.md","content":"..."}]}.',
    'Authoring rules:',
    '- The description must explain what the skill does and when to use it.',
    '- Use a stable procedure, not a one-off transcript.',
    '- Do not invent commands, APIs, credentials, or helper scripts that are not supported by the source.',
    '- If details are uncertain, put them in Pitfalls or Verification instead of pretending they are known.',
    '- Use these body sections when useful: When to Use, Procedure, Pitfalls, Verification.',
    '- Keep the main body concise; put detailed notes in references/source-summary.md.',
    '- Do not include secrets, raw tokens, passwords, private keys, or live personal contact details.',
    input.suggestedName
      ? `Use this exact skill name unless it would violate the slug format: ${input.suggestedName}.`
      : '',
    input.category ? `Preferred category: ${input.category}.` : '',
    input.source.focus ? `Operator focus: ${input.source.focus}.` : '',
    '',
    `Source kind: ${input.source.kind}`,
    `Source label: ${input.source.label}`,
    '',
    sourceBlocks.join('\n\n'),
  ]
    .filter(Boolean)
    .join('\n');
}

function extractJsonObject(text: string): ParsedAuthoringOutput {
  let trimmed = text.trim();
  const fencedJsonMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fencedJsonMatch?.[1]) {
    trimmed = fencedJsonMatch[1].trim();
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ParsedAuthoringOutput;
    }
  } catch {
    // fall through to the uniform error below
  }
  throw new SkillDraftInputError(
    502,
    'Skill creation proposal did not return valid JSON.',
  );
}

function normalizeDraftFromModel(input: {
  output: string;
  suggestedName?: string;
  category?: string;
  source: CollectedSkillSource;
}): ManagedSkillDraft {
  const parsed = extractJsonObject(input.output);
  const rawName =
    input.suggestedName ||
    (typeof parsed.name === 'string' ? parsed.name : '') ||
    input.source.label;
  const name = normalizeSkillSlug(rawName);
  const description =
    typeof parsed.description === 'string' ? parsed.description.trim() : '';
  const shortDescription =
    (typeof parsed.shortDescription === 'string'
      ? parsed.shortDescription
      : typeof parsed.short_description === 'string'
        ? parsed.short_description
        : ''
    ).trim() || undefined;
  const body = typeof parsed.body === 'string' ? parsed.body.trim() : '';
  const files = normalizeGeneratedFiles(parsed.files);
  if (!files.some((file) => file.path === 'references/learned-sources.md')) {
    files.push({
      path: 'references/learned-sources.md',
      content: buildSourceReference(input.source),
    });
  }
  return {
    name,
    description,
    category:
      input.category ||
      (typeof parsed.category === 'string' ? parsed.category : undefined),
    shortDescription,
    userInvocable: true,
    disableModelInvocation: false,
    tags: normalizeTags(parsed.tags),
    body,
    files,
  };
}

function skillCreationProposalsDir(): string {
  return path.join(DATA_DIR, 'skill-creation-proposals');
}

function proposalDir(id: string): string {
  if (!/^skill-create-[a-z0-9-]+$/.test(id)) {
    throw new SkillDraftInputError(
      400,
      `Invalid skill creation proposal id: ${id}`,
    );
  }
  return path.join(skillCreationProposalsDir(), id);
}

function proposalPath(id: string): string {
  return path.join(proposalDir(id), 'proposal.json');
}

function writeProposal(proposal: SkillCreationProposal): SkillCreationProposal {
  fs.mkdirSync(proposalDir(proposal.id), { recursive: true });
  fs.writeFileSync(
    proposalPath(proposal.id),
    JSON.stringify(proposal, null, 2),
    'utf-8',
  );
  return proposal;
}

export function getSkillCreationProposal(id: string): SkillCreationProposal {
  const rawPath = proposalPath(id);
  if (!fs.existsSync(rawPath)) {
    throw new SkillDraftInputError(
      404,
      `Skill creation proposal \`${id}\` was not found.`,
    );
  }
  return JSON.parse(fs.readFileSync(rawPath, 'utf-8')) as SkillCreationProposal;
}

export async function stageSkillCreationFromSources(input: {
  sourceDescription: string;
  suggestedName?: string;
  category?: string;
  agentId: string;
}): Promise<SkillCreationProposal> {
  const source = await collectSourceMaterial(input.sourceDescription);
  const output = await runAgent({
    sessionId: `skill-authoring-${randomUUID()}`,
    agentId: input.agentId,
    channelId: 'skill-authoring',
    chatbotId: HYBRIDAI_CHATBOT_ID || input.agentId,
    enableRag: false,
    messages: [
      {
        role: 'user',
        content: buildSkillAuthoringPrompt({
          source,
          suggestedName: input.suggestedName,
          category: input.category,
        }),
      },
    ],
    allowedTools: [],
  });
  if (output.status === 'error' || !output.result?.trim()) {
    throw new SkillDraftInputError(
      502,
      output.error || 'Skill creation proposal failed.',
    );
  }

  const draft = normalizeDraftFromModel({
    output: output.result,
    suggestedName: input.suggestedName,
    category: input.category,
    source,
  });
  const id = `skill-create-${Date.now().toString(36)}-${randomUUID()
    .slice(0, 8)
    .toLowerCase()}`;
  const rootDir = proposalDir(id);
  const packageDir = path.join(rootDir, 'package');
  writeSkillPackage({ skillDir: packageDir, draft });
  const guardDecision = guardSkillDirectory({
    skillName: draft.name,
    skillPath: packageDir,
    sourceTag: 'workspace',
  });
  const now = new Date().toISOString();
  return writeProposal({
    id,
    status: 'staged',
    createdAt: now,
    updatedAt: now,
    appliedAt: null,
    rejectedAt: null,
    agentId: input.agentId,
    sourceDescription: input.sourceDescription,
    sourceKind: source.kind,
    focus: source.focus,
    draft,
    packageDir,
    guard: {
      allowed: guardDecision.allowed,
      reason: guardDecision.reason,
      verdict: guardDecision.result.verdict,
      findingsCount: guardDecision.result.findings.length,
      findings: guardDecision.result.findings,
    },
  });
}

export function applySkillCreationProposal(id: string): SkillCreationProposal {
  const proposal = getSkillCreationProposal(id);
  if (proposal.status !== 'staged') {
    throw new SkillDraftInputError(
      409,
      `Skill creation proposal \`${id}\` is already ${proposal.status}.`,
    );
  }
  if (!proposal.guard.allowed) {
    throw new SkillDraftInputError(
      400,
      `Skill creation proposal \`${id}\` is blocked by the scanner: ${proposal.guard.reason}.`,
    );
  }
  const applied = createManagedSkillFromDraft(proposal.draft);
  const now = new Date().toISOString();
  return writeProposal({
    ...proposal,
    status: 'applied',
    updatedAt: now,
    appliedAt: now,
    appliedSkillDir: applied.skillDir,
  });
}

export function rejectSkillCreationProposal(id: string): SkillCreationProposal {
  const proposal = getSkillCreationProposal(id);
  if (proposal.status !== 'staged') {
    throw new SkillDraftInputError(
      409,
      `Skill creation proposal \`${id}\` is already ${proposal.status}.`,
    );
  }
  const now = new Date().toISOString();
  return writeProposal({
    ...proposal,
    status: 'rejected',
    updatedAt: now,
    rejectedAt: now,
  });
}

export function formatSkillCreationProposal(
  proposal: SkillCreationProposal,
  options: { commandPrefix?: string } = {},
): string {
  const commandPrefix = options.commandPrefix || 'hybridclaw skill create-from';
  const lines = [
    `ID: ${proposal.id}`,
    `Status: ${proposal.status}`,
    `Name: ${proposal.draft.name}`,
    `Description: ${proposal.draft.description}`,
    `Category: ${normalizeCreatedSkillCategory(proposal.draft.category)}`,
    `Source: ${proposal.sourceKind} (${proposal.sourceDescription})`,
    `Package preview: ${proposal.packageDir}`,
    `Guard: ${proposal.guard.verdict}/${proposal.guard.findingsCount} — ${proposal.guard.reason}`,
  ];
  if (proposal.guard.findings.length > 0) {
    const finding = proposal.guard.findings[0];
    lines.push(
      `First finding: ${finding.severity}/${finding.category}: ${finding.description} (${finding.file}:${finding.line})`,
    );
  }
  if (proposal.status === 'staged') {
    lines.push(
      '',
      `Apply: ${commandPrefix} --apply ${proposal.id}`,
      `Reject: ${commandPrefix} --reject ${proposal.id}`,
    );
  }
  if (proposal.appliedSkillDir) {
    lines.push(`Installed to: ${proposal.appliedSkillDir}`);
  }
  return lines.join('\n');
}
