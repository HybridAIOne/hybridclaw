/**
 * Skills — CLAUDE/OpenClaw-compatible SKILL.md discovery.
 * The system prompt includes skill metadata + location, and inlines full
 * bodies for skills marked `always: true`.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRuntimeConfig } from '../config/runtime-config.js';
import { agentWorkspaceDir } from '../infra/ipc.js';
import { logger } from '../logger.js';
import { guardSkillDirectory } from './skills-guard.js';

type SkillSource =
  | 'extra'
  | 'bundled'
  | 'codex'
  | 'claude'
  | 'agents-personal'
  | 'agents-project'
  | 'community'
  | 'workspace';

export type SkillInstallKind =
  | 'brew'
  | 'uv'
  | 'npm'
  | 'node'
  | 'go'
  | 'download';

export interface SkillInstallSpec {
  id?: string;
  kind: SkillInstallKind;
  label?: string;
  bins?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  path?: string;
  chmod?: string;
}

interface SkillCandidate {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  always: boolean;
  requires: {
    bins: string[];
    env: string[];
  };
  metadata: {
    hybridclaw: {
      tags: string[];
      relatedSkills: string[];
      install: SkillInstallSpec[];
    };
  };
  filePath: string;
  baseDir: string;
  source: SkillSource;
}

export interface Skill {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  always: boolean;
  requires: {
    bins: string[];
    env: string[];
  };
  metadata: {
    hybridclaw: {
      tags: string[];
      relatedSkills: string[];
      install: SkillInstallSpec[];
    };
  };
  filePath: string;
  baseDir: string;
  source: SkillSource;
  location: string;
}

const WORKSPACE_SKILLS_DIR = path.join(process.cwd(), 'skills');
const PROJECT_AGENTS_SKILLS_DIR = path.join(process.cwd(), '.agents', 'skills');
const SYNCED_SKILLS_DIR = '.synced-skills';
const MAX_SKILLS_IN_PROMPT = 150;
const MAX_SKILLS_PROMPT_CHARS = 30_000;
const MAX_INVOKED_SKILL_CHARS = 35_000;
const MAX_ALWAYS_CHARS = 10_000;
const MAX_SKILL_COMMAND_NAME_LENGTH = 32;
const RESERVED_SKILL_COMMAND_NAMES = new Set<string>([
  'help',
  'clear',
  'compact',
  'new',
  'status',
  'bot',
  'bots',
  'rag',
  'info',
  'stop',
  'abort',
  'exit',
  'quit',
  'q',
  'model',
  'sessions',
  'audit',
  'schedule',
  'skill',
]);
const warnedBlockedSkills = new Set<string>();

type FrontmatterParseResult = {
  meta: Record<string, string>;
  body: string;
  block: string;
};

type FrontmatterSection = {
  inline: string;
  children: string[];
};

type SkillCommandSpec = {
  name: string;
  skillName: string;
  skill: Skill;
};

function normalizeLineEndings(raw: string): string {
  return raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseFrontmatter(raw: string): FrontmatterParseResult {
  const normalized = normalizeLineEndings(raw);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { meta: {}, body: normalized.trim(), block: '' };
  }

  const block = match[1] || '';
  const body = normalized.slice(match[0].length).trim();
  const meta: Record<string, string> = {};

  for (const line of block.split('\n')) {
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const value = stripQuotes((m[2] || '').trim());
    if (!key || !value) continue;
    meta[key] = value;
  }

  return { meta, body, block };
}

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toPosixPath(p: string): string {
  return p.split(path.sep).join('/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function leadingWhitespaceCount(line: string): number {
  let count = 0;
  while (count < line.length) {
    const ch = line[count];
    if (ch !== ' ' && ch !== '\t') break;
    count += 1;
  }
  return count;
}

function parseInlineStringList(raw: string): string[] {
  const trimmed = stripQuotes(raw.trim());
  if (!trimmed) return [];
  if (trimmed === '[]') return [];
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(',')
      .map((item) => stripQuotes(item.trim()))
      .filter(Boolean);
  }
  return [trimmed];
}

function normalizeStringList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) =>
        typeof item === 'string' ? item.trim() : String(item ?? '').trim(),
      )
      .filter(Boolean);
  }
  if (typeof raw === 'string') {
    const inline = parseInlineStringList(raw);
    if (inline.length > 0) return inline;
    return raw
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function tryParseJsonArray(raw: string): unknown[] | null {
  const trimmed = stripQuotes(raw.trim());
  if (!trimmed || !trimmed.startsWith('[')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeInstallSpecs(raw: unknown): SkillInstallSpec[] {
  if (!Array.isArray(raw)) return [];

  const specs: SkillInstallSpec[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const kindRaw =
      typeof entry.kind === 'string' ? entry.kind.trim().toLowerCase() : '';
    if (
      kindRaw !== 'brew' &&
      kindRaw !== 'uv' &&
      kindRaw !== 'npm' &&
      kindRaw !== 'node' &&
      kindRaw !== 'go' &&
      kindRaw !== 'download'
    ) {
      continue;
    }

    specs.push({
      id: typeof entry.id === 'string' ? entry.id.trim() : undefined,
      kind: kindRaw,
      label: typeof entry.label === 'string' ? entry.label.trim() : undefined,
      bins: normalizeStringList(entry.bins),
      formula:
        typeof entry.formula === 'string' ? entry.formula.trim() : undefined,
      package:
        typeof entry.package === 'string' ? entry.package.trim() : undefined,
      module:
        typeof entry.module === 'string' ? entry.module.trim() : undefined,
      url: typeof entry.url === 'string' ? entry.url.trim() : undefined,
      path: typeof entry.path === 'string' ? entry.path.trim() : undefined,
      chmod: typeof entry.chmod === 'string' ? entry.chmod.trim() : undefined,
    });
  }
  return specs;
}

function tryParseJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = stripQuotes(raw.trim());
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('[')))
    return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (isRecord(parsed)) return parsed;
  } catch {
    // ignore invalid JSON-ish values
  }
  return null;
}

function extractTopLevelSection(
  block: string,
  key: string,
): FrontmatterSection | null {
  const lines = block.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] || '';
    const match = line.match(/^([ \t]*)([\w-]+):\s*(.*)$/);
    if (!match) continue;
    const indent = (match[1] || '').length;
    const candidate = (match[2] || '').trim();
    if (indent !== 0 || candidate !== key) continue;

    const inline = (match[3] || '').trim();
    const children: string[] = [];

    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j] || '';
      const trimmed = next.trim();
      if (!trimmed) {
        children.push(next);
        j += 1;
        continue;
      }

      const nextIndent = leadingWhitespaceCount(next);
      if (nextIndent <= indent) break;
      children.push(next);
      j += 1;
    }
    return { inline, children };
  }
  return null;
}

function parseSectionChildren(
  children: string[],
): Map<string, FrontmatterSection> {
  const parsed = new Map<string, FrontmatterSection>();
  for (let i = 0; i < children.length; ) {
    const line = children[i] || '';
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }

    const match = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (!match) {
      i += 1;
      continue;
    }

    const key = (match[1] || '').trim();
    const inline = (match[2] || '').trim();
    const indent = leadingWhitespaceCount(line);
    const nested: string[] = [];
    i += 1;

    while (i < children.length) {
      const next = children[i] || '';
      const nextTrimmed = next.trim();
      if (!nextTrimmed) {
        nested.push(next);
        i += 1;
        continue;
      }
      const nextIndent = leadingWhitespaceCount(next);
      if (nextIndent <= indent) break;
      nested.push(next);
      i += 1;
    }

    if (key) parsed.set(key, { inline, children: nested });
  }
  return parsed;
}

function parseSectionStringList(
  section: FrontmatterSection | undefined,
): string[] {
  if (!section) return [];
  const inline = parseInlineStringList(section.inline);
  if (inline.length > 0 || section.inline.trim() === '[]') return inline;
  const values: string[] = [];
  for (const line of section.children) {
    const trimmed = line.trim();
    const match = trimmed.match(/^-\s*(.+)$/);
    if (!match) continue;
    const value = stripQuotes((match[1] || '').trim());
    if (value) values.push(value);
  }
  return values;
}

function parseSectionObjectList(
  section: FrontmatterSection | undefined,
): Record<string, string>[] {
  if (!section) return [];
  const values: Record<string, string>[] = [];
  let current: Record<string, string> | null = null;

  for (const line of section.children) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const itemMatch = trimmed.match(/^-\s*(.*)$/);
    if (itemMatch) {
      if (current && Object.keys(current).length > 0) values.push(current);
      current = {};
      const remainder = (itemMatch[1] || '').trim();
      if (!remainder) continue;
      const inlineMatch = remainder.match(/^([\w-]+):\s*(.*)$/);
      if (inlineMatch) {
        current[inlineMatch[1]] = stripQuotes((inlineMatch[2] || '').trim());
      }
      continue;
    }

    const fieldMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (!fieldMatch) continue;
    if (!current) current = {};
    current[fieldMatch[1]] = stripQuotes((fieldMatch[2] || '').trim());
  }

  if (current && Object.keys(current).length > 0) values.push(current);
  return values;
}

function parseRequiresFromFrontmatter(frontmatter: FrontmatterParseResult): {
  bins: string[];
  env: string[];
} {
  const fromInlineJson = frontmatter.meta.requires
    ? tryParseJsonObject(frontmatter.meta.requires)
    : null;
  if (fromInlineJson) {
    return {
      bins: normalizeStringList(fromInlineJson.bins),
      env: normalizeStringList(fromInlineJson.env),
    };
  }

  const section = extractTopLevelSection(frontmatter.block, 'requires');
  if (!section) return { bins: [], env: [] };

  const inlineJson = tryParseJsonObject(section.inline);
  if (inlineJson) {
    return {
      bins: normalizeStringList(inlineJson.bins),
      env: normalizeStringList(inlineJson.env),
    };
  }

  const fields = parseSectionChildren(section.children);
  return {
    bins: parseSectionStringList(fields.get('bins')),
    env: parseSectionStringList(fields.get('env')),
  };
}

function parseHybridClawMetadata(frontmatter: FrontmatterParseResult): {
  tags: string[];
  relatedSkills: string[];
  install: SkillInstallSpec[];
} {
  const normalizeMetadata = (
    raw: Record<string, unknown>,
  ): {
    tags: string[];
    relatedSkills: string[];
    install: SkillInstallSpec[];
  } => {
    const hybridRaw = isRecord(raw.hybridclaw) ? raw.hybridclaw : raw;
    return {
      tags: normalizeStringList(hybridRaw.tags),
      relatedSkills: normalizeStringList(
        hybridRaw.related_skills ?? hybridRaw.relatedSkills,
      ),
      install: normalizeInstallSpecs(hybridRaw.install),
    };
  };

  const fromInlineJson = frontmatter.meta.metadata
    ? tryParseJsonObject(frontmatter.meta.metadata)
    : null;
  if (fromInlineJson) return normalizeMetadata(fromInlineJson);

  const metadataSection = extractTopLevelSection(frontmatter.block, 'metadata');
  if (!metadataSection) return { tags: [], relatedSkills: [], install: [] };

  const metadataInlineJson = tryParseJsonObject(metadataSection.inline);
  if (metadataInlineJson) return normalizeMetadata(metadataInlineJson);

  const metadataFields = parseSectionChildren(metadataSection.children);
  const hybridSection = metadataFields.get('hybridclaw');
  if (!hybridSection) return { tags: [], relatedSkills: [], install: [] };

  const hybridInlineJson = tryParseJsonObject(hybridSection.inline);
  if (hybridInlineJson) return normalizeMetadata(hybridInlineJson);

  const hybridFields = parseSectionChildren(hybridSection.children);
  const installSection = hybridFields.get('install');
  const installInlineJson = installSection
    ? tryParseJsonArray(installSection.inline)
    : null;
  return {
    tags: parseSectionStringList(hybridFields.get('tags')),
    relatedSkills: parseSectionStringList(hybridFields.get('related_skills')),
    install: normalizeInstallSpecs(
      installInlineJson ?? parseSectionObjectList(installSection),
    ),
  };
}

let cachedPathEnv = '';
let cachedPathExt = '';
const hasBinaryCache = new Map<string, boolean>();

export function hasBinary(binName: string): boolean {
  const bin = binName.trim();
  if (!bin) return false;

  const currentPath = process.env.PATH || '';
  const currentPathExt =
    process.platform === 'win32' ? process.env.PATHEXT || '' : '';
  if (cachedPathEnv !== currentPath || cachedPathExt !== currentPathExt) {
    cachedPathEnv = currentPath;
    cachedPathExt = currentPathExt;
    hasBinaryCache.clear();
  }

  const cached = hasBinaryCache.get(bin);
  if (cached != null) return cached;

  const exts =
    process.platform === 'win32'
      ? [
          '',
          ...currentPathExt
            .split(';')
            .map((ext) => ext.trim())
            .filter(Boolean),
        ]
      : [''];
  for (const part of currentPath.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = path.join(part, `${bin}${ext}`);
      try {
        fs.accessSync(candidate, fs.constants.X_OK);
        hasBinaryCache.set(bin, true);
        return true;
      } catch {
        // continue scanning
      }
    }
  }

  hasBinaryCache.set(bin, false);
  return false;
}

function checkEligibility(skill: {
  requires?: {
    bins?: string[];
    env?: string[];
  };
}): {
  available: boolean;
  missing: string[];
} {
  const missing: string[] = [];
  for (const bin of skill.requires?.bins ?? []) {
    if (!hasBinary(bin)) missing.push(`bin:${bin}`);
  }
  for (const envVar of skill.requires?.env ?? []) {
    if (!process.env[envVar]) missing.push(`env:${envVar}`);
  }
  return { available: missing.length === 0, missing };
}

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function asContainerPath(
  workspaceDir: string,
  absolutePath: string,
): string | null {
  if (!pathWithin(workspaceDir, absolutePath)) return null;
  const rel = toPosixPath(path.relative(workspaceDir, absolutePath));
  return rel ? `/workspace/${rel}` : '/workspace';
}

function resolveUserPath(raw: string): string {
  const value = raw.trim();
  if (!value) return '';
  if (value === '~') return os.homedir();
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function resolveBundledSkillsDir(): string | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledDir = path.resolve(moduleDir, '..', 'skills');
  return fs.existsSync(bundledDir) ? bundledDir : null;
}

function resolveCodexSkillsDirs(): string[] {
  const home = os.homedir();
  const dirs: string[] = [path.join(home, '.codex', 'skills')];

  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    dirs.unshift(path.join(codexHome, 'skills'));
  }

  const seen = new Set<string>();
  return dirs.filter((dir) => {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

function scanSkillsDir(dir: string, source: SkillSource): SkillCandidate[] {
  if (!fs.existsSync(dir)) return [];

  const skills: SkillCandidate[] = [];

  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      const baseDir = path.join(dir, entry.name);
      const skillFile = path.join(baseDir, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const raw = fs.readFileSync(skillFile, 'utf-8');
        const frontmatter = parseFrontmatter(raw);
        const { meta } = frontmatter;
        const name = (meta.name || entry.name).trim();
        if (!name) continue;
        const always = parseBool(meta.always, false);
        const requires = parseRequiresFromFrontmatter(frontmatter);
        const metadataHybridClaw = parseHybridClawMetadata(frontmatter);

        skills.push({
          name,
          description: (meta.description || '').trim(),
          userInvocable: parseBool(meta['user-invocable'], true),
          disableModelInvocation: parseBool(
            meta['disable-model-invocation'],
            false,
          ),
          always,
          requires,
          metadata: {
            hybridclaw: metadataHybridClaw,
          },
          filePath: skillFile,
          baseDir,
          source,
        });
      } catch (err) {
        logger.warn({ path: skillFile, err }, 'Failed to parse skill');
      }
    }
  } catch (err) {
    logger.warn({ dir, err }, 'Failed to scan skills directory');
  }

  return skills;
}

function sanitizeSkillDirName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'skill';
}

function stableSkillDirName(name: string): string {
  const base = sanitizeSkillDirName(name);
  const hash = createHash('sha1').update(name).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

function buildDirectoryContentSignature(rootDir: string): string {
  const resolvedRoot = path.resolve(rootDir);
  const entries: string[] = [];
  const stack = [resolvedRoot];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    const dirEntries = fs
      .readdirSync(currentDir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      const relPath = path
        .relative(resolvedRoot, fullPath)
        .split(path.sep)
        .join('/');
      const contentHash = createHash('sha1')
        .update(fs.readFileSync(fullPath))
        .digest('hex');
      entries.push(`${relPath}:${contentHash}`);
    }
  }

  return createHash('sha1').update(entries.join('\n')).digest('hex');
}

function resolveSyncedSkillTarget(
  skill: SkillCandidate,
  workspaceDir: string,
): { rootDir: string; targetDir: string; targetSkillFile: string } {
  // Keep bundled skills under /workspace/skills so bundled docs can refer to
  // skill-local scripts with stable paths like "skills/<skill>/scripts/...".
  if (skill.source === 'bundled') {
    const rootDir = path.join(workspaceDir, 'skills');
    const dirName = sanitizeSkillDirName(path.basename(skill.baseDir));
    const targetDir = path.join(rootDir, dirName);
    return {
      rootDir,
      targetDir,
      targetSkillFile: path.join(targetDir, 'SKILL.md'),
    };
  }

  // Keep workspace skills under /workspace/skills so script paths like
  // "skills/<skill>/scripts/..." remain valid inside the agent container.
  if (skill.source === 'workspace') {
    const workspaceRoot = path.resolve(WORKSPACE_SKILLS_DIR);
    const skillBaseDir = path.resolve(skill.baseDir);
    if (pathWithin(workspaceRoot, skillBaseDir)) {
      const rel = path.relative(workspaceRoot, skillBaseDir);
      const rootDir = path.join(workspaceDir, 'skills');
      const targetDir = path.join(rootDir, rel);
      return {
        rootDir,
        targetDir,
        targetSkillFile: path.join(targetDir, 'SKILL.md'),
      };
    }
  }

  // Keep project .agents skills under /workspace/.agents/skills for path-compat.
  if (skill.source === 'agents-project') {
    const projectAgentsRoot = path.resolve(PROJECT_AGENTS_SKILLS_DIR);
    const skillBaseDir = path.resolve(skill.baseDir);
    if (pathWithin(projectAgentsRoot, skillBaseDir)) {
      const rel = path.relative(projectAgentsRoot, skillBaseDir);
      const rootDir = path.join(workspaceDir, '.agents', 'skills');
      const targetDir = path.join(rootDir, rel);
      return {
        rootDir,
        targetDir,
        targetSkillFile: path.join(targetDir, 'SKILL.md'),
      };
    }
  }

  const rootDir = path.join(workspaceDir, SYNCED_SKILLS_DIR);
  const dirName = stableSkillDirName(skill.name);
  const targetDir = path.join(rootDir, dirName);
  return {
    rootDir,
    targetDir,
    targetSkillFile: path.join(targetDir, 'SKILL.md'),
  };
}

function syncSkillIntoWorkspace(
  skill: SkillCandidate,
  workspaceDir: string,
): string {
  const { rootDir, targetDir, targetSkillFile } = resolveSyncedSkillTarget(
    skill,
    workspaceDir,
  );
  fs.mkdirSync(rootDir, { recursive: true });

  if (!pathWithin(rootDir, targetDir)) {
    throw new Error(`Unsafe synced skill path: ${targetDir}`);
  }

  let shouldSync = true;
  try {
    if (fs.existsSync(targetSkillFile)) {
      shouldSync =
        buildDirectoryContentSignature(skill.baseDir) !==
        buildDirectoryContentSignature(targetDir);
    }
  } catch {
    shouldSync = true;
  }

  if (shouldSync) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.cpSync(skill.baseDir, targetDir, { recursive: true, force: true });
  }

  return targetSkillFile;
}

function collectSyncedSkillDirs(rootDir: string): string[] {
  if (!fs.existsSync(rootDir)) return [];

  const skillDirs: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) continue;

    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch (err) {
      logger.debug(
        { rootDir, currentDir, err },
        'Failed to scan synced skill dir',
      );
      continue;
    }

    if (
      entries.some(
        (entry) => entry.isFile() && entry.name.toLowerCase() === 'skill.md',
      )
    ) {
      skillDirs.push(currentDir);
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      stack.push(path.join(currentDir, entry.name));
    }
  }

  return skillDirs;
}

function pruneStaleSyncedSkills(
  skills: SkillCandidate[],
  workspaceDir: string,
): void {
  const desiredByRoot = new Map<string, Set<string>>();

  for (const skill of skills) {
    const { rootDir, targetDir } = resolveSyncedSkillTarget(
      skill,
      workspaceDir,
    );
    const resolvedRoot = path.resolve(rootDir);
    const resolvedTarget = path.resolve(targetDir);
    if (!desiredByRoot.has(resolvedRoot)) {
      desiredByRoot.set(resolvedRoot, new Set<string>());
    }
    desiredByRoot.get(resolvedRoot)?.add(resolvedTarget);
  }

  for (const [rootDir, desiredDirs] of desiredByRoot) {
    for (const skillDir of collectSyncedSkillDirs(rootDir)) {
      const resolvedSkillDir = path.resolve(skillDir);
      if (desiredDirs.has(resolvedSkillDir)) continue;
      if (!pathWithin(rootDir, resolvedSkillDir)) {
        logger.warn(
          { rootDir, skillDir: resolvedSkillDir },
          'Refusing to prune synced skill outside sync root',
        );
        continue;
      }
      fs.rmSync(resolvedSkillDir, { recursive: true, force: true });
    }
  }
}

function normalizeSkillLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function sanitizeCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_COMMAND_NAME_LENGTH);
}

function resolveUniqueCommandName(
  baseName: string,
  usedNames: Set<string>,
): string | null {
  const normalizedBase = (baseName || 'skill').slice(
    0,
    MAX_SKILL_COMMAND_NAME_LENGTH,
  );
  if (!usedNames.has(normalizedBase)) {
    usedNames.add(normalizedBase);
    return normalizedBase;
  }

  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const prefixLen = Math.max(
      1,
      MAX_SKILL_COMMAND_NAME_LENGTH - suffix.length,
    );
    const candidate = `${normalizedBase.slice(0, prefixLen)}${suffix}`;
    if (usedNames.has(candidate)) continue;
    usedNames.add(candidate);
    return candidate;
  }
  return null;
}

function buildSkillCommandSpecs(skills: Skill[]): SkillCommandSpec[] {
  const used = new Set<string>(
    Array.from(RESERVED_SKILL_COMMAND_NAMES.values()),
  );
  const specs: SkillCommandSpec[] = [];

  for (const skill of skills) {
    if (!skill.userInvocable) continue;
    const base = sanitizeCommandName(skill.name);
    const name = resolveUniqueCommandName(base, used);
    if (!name) continue;
    specs.push({
      name,
      skillName: skill.name,
      skill,
    });
  }

  return specs;
}

function findSkillCommand(
  skillCommands: SkillCommandSpec[],
  rawName: string,
): SkillCommandSpec | null {
  const lowered = rawName.trim().toLowerCase();
  if (!lowered) return null;
  const sanitized = sanitizeCommandName(rawName);
  return (
    skillCommands.find(
      (entry) =>
        entry.name === lowered || (sanitized && entry.name === sanitized),
    ) || null
  );
}

function findInvocableSkill(skills: Skill[], rawName: string): Skill | null {
  const target = rawName.trim().toLowerCase();
  if (!target) return null;
  const normalizedTarget = normalizeSkillLookup(rawName);
  return (
    skills.find((skill) => {
      if (!skill.userInvocable) return false;
      const name = skill.name.toLowerCase();
      if (name === target) return true;
      return normalizeSkillLookup(skill.name) === normalizedTarget;
    }) || null
  );
}

function parseSkillInvocation(
  content: string,
  skills: Skill[],
): { skill: Skill; args: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;
  const skillCommands = buildSkillCommandSpecs(skills);

  const commandMatch = trimmed.match(/^\/([^\s]+)(?:\s+([\s\S]+))?$/);
  if (!commandMatch) return null;

  const commandName = (commandMatch[1] || '').trim();
  const remainder = (commandMatch[2] || '').trim();
  if (!commandName) return null;

  const lowerCommand = commandName.toLowerCase();
  if (lowerCommand === 'skill') {
    if (!remainder) return null;
    const skillMatch = remainder.match(/^([^\s]+)(?:\s+([\s\S]+))?$/);
    if (!skillMatch) return null;
    const explicitName = (skillMatch[1] || '').trim();
    const explicitSkill = findInvocableSkill(skills, explicitName);
    const skill =
      explicitSkill ||
      findSkillCommand(skillCommands, explicitName)?.skill ||
      null;
    if (!skill) return null;
    return { skill, args: (skillMatch[2] || '').trim() };
  }

  if (lowerCommand.startsWith('skill:')) {
    const skillName = commandName.slice('skill:'.length).trim();
    if (!skillName) return null;
    const explicitSkill = findInvocableSkill(skills, skillName);
    const skill =
      explicitSkill ||
      findSkillCommand(skillCommands, skillName)?.skill ||
      null;
    if (!skill) return null;
    return { skill, args: remainder };
  }

  const directSkillCommand = findSkillCommand(skillCommands, commandName);
  if (!directSkillCommand) return null;
  return { skill: directSkillCommand.skill, args: remainder };
}

function loadSkillBody(skill: Skill, maxChars: number): string {
  try {
    const raw = fs.readFileSync(skill.filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    if (body.length <= maxChars) return body;
    return `${body.slice(0, maxChars)}\n\n[truncated]`;
  } catch (err) {
    logger.warn(
      { skill: skill.name, path: skill.filePath, err },
      'Failed to load SKILL.md body',
    );
    return '';
  }
}

/**
 * Expand explicit skill command invocations into a deterministic user payload.
 * Supports:
 * - /skill <name> [input]
 * - /skill:<name> [input]
 * - /<name> [input] (user-invocable skills)
 */
export function expandSkillInvocation(
  content: string,
  skills: Skill[],
): string {
  const invocation = parseSkillInvocation(content, skills);
  if (!invocation) return content;

  const body = loadSkillBody(invocation.skill, MAX_INVOKED_SKILL_CHARS);
  const args = invocation.args || '(none)';

  const lines = [
    `[Explicit skill invocation] Use the "${invocation.skill.name}" skill for this request.`,
    `Skill file: ${invocation.skill.location}`,
    `Skill input: ${args}`,
  ];

  if (body) {
    lines.push('', '<skill_instructions>', body, '</skill_instructions>');
  } else {
    lines.push('Read the skill file with the `read` tool and follow it.');
  }

  return lines.join('\n');
}

export interface SkillCatalogEntry {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  always: boolean;
  requires: {
    bins: string[];
    env: string[];
  };
  metadata: {
    hybridclaw: {
      tags: string[];
      relatedSkills: string[];
      install: SkillInstallSpec[];
    };
  };
  filePath: string;
  baseDir: string;
  source: SkillSource;
  available: boolean;
  missing: string[];
}

function collectResolvedSkillCandidates(): SkillCandidate[] {
  const config = getRuntimeConfig();
  const extraDirs = (config.skills?.extraDirs ?? [])
    .map((dir) => resolveUserPath(dir))
    .filter(Boolean);
  const bundledSkillsDir = resolveBundledSkillsDir();
  const codexDirs = resolveCodexSkillsDirs();
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const agentsPersonalSkillsDir = path.join(os.homedir(), '.agents', 'skills');

  const extraSkills = extraDirs.flatMap((dir) => scanSkillsDir(dir, 'extra'));
  const bundledSkills = bundledSkillsDir
    ? scanSkillsDir(bundledSkillsDir, 'bundled')
    : [];
  const codexSkills = codexDirs.flatMap((dir) => scanSkillsDir(dir, 'codex'));
  const claudeSkills = scanSkillsDir(claudeSkillsDir, 'claude');
  const agentsPersonalSkills = scanSkillsDir(
    agentsPersonalSkillsDir,
    'agents-personal',
  );
  const projectAgentsSkills = scanSkillsDir(
    PROJECT_AGENTS_SKILLS_DIR,
    'agents-project',
  );
  const workspaceSkills = scanSkillsDir(WORKSPACE_SKILLS_DIR, 'workspace');

  const byName = new Map<string, SkillCandidate>();
  for (const skill of extraSkills) byName.set(skill.name, skill);
  for (const skill of bundledSkills) byName.set(skill.name, skill);
  for (const skill of codexSkills) byName.set(skill.name, skill);
  for (const skill of claudeSkills) byName.set(skill.name, skill);
  for (const skill of agentsPersonalSkills) byName.set(skill.name, skill);
  for (const skill of projectAgentsSkills) byName.set(skill.name, skill);
  for (const skill of workspaceSkills) byName.set(skill.name, skill);

  return Array.from(byName.values());
}

function filterGuardedSkillCandidates(
  skills: SkillCandidate[],
): SkillCandidate[] {
  return skills.filter((skill) => {
    const decision = guardSkillDirectory({
      skillName: skill.name,
      skillPath: skill.baseDir,
      sourceTag: skill.source,
    });
    if (decision.allowed) return true;

    const fingerprint = `${path.resolve(skill.baseDir)}:${decision.result.verdict}:${decision.result.findings.length}`;
    if (!warnedBlockedSkills.has(fingerprint)) {
      warnedBlockedSkills.add(fingerprint);
      logger.warn(
        {
          skill: skill.name,
          source: skill.source,
          trustLevel: decision.result.trustLevel,
          verdict: decision.result.verdict,
          findings: decision.result.findings.length,
          reason: decision.reason,
        },
        'Blocked skill by security scanner',
      );
    }
    return false;
  });
}

export function loadSkillCatalog(): SkillCatalogEntry[] {
  const candidates = filterGuardedSkillCandidates(
    collectResolvedSkillCandidates(),
  );
  return candidates
    .map((skill) => {
      const eligibility = checkEligibility(skill);
      return {
        ...skill,
        available: eligibility.available,
        missing: eligibility.missing,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Load all skills with precedence:
 * extra < bundled < codex < claude < agents-personal < agents-project < workspace.
 * Any non-workspace skill selected by precedence is mirrored into workspace so
 * the container can read it via /workspace/... paths.
 */
export function loadSkills(agentId: string): Skill[] {
  const workspaceDir = path.resolve(agentWorkspaceDir(agentId));
  fs.mkdirSync(workspaceDir, { recursive: true });
  const guarded = filterGuardedSkillCandidates(
    collectResolvedSkillCandidates(),
  ).filter((skill) => checkEligibility(skill).available);
  pruneStaleSyncedSkills(guarded, workspaceDir);

  const resolved: Skill[] = [];
  for (const skill of guarded) {
    try {
      let containerSkillPath = asContainerPath(
        workspaceDir,
        path.resolve(skill.filePath),
      );
      if (!containerSkillPath) {
        const syncedSkillFile = syncSkillIntoWorkspace(skill, workspaceDir);
        containerSkillPath = asContainerPath(
          workspaceDir,
          path.resolve(syncedSkillFile),
        );
      }
      if (!containerSkillPath) {
        logger.warn(
          { skill: skill.name, path: skill.filePath },
          'Could not resolve container-readable skill path',
        );
        continue;
      }

      resolved.push({
        ...skill,
        location: containerSkillPath,
      });
    } catch (err) {
      logger.warn(
        { skill: skill.name, err },
        'Failed to resolve skill location',
      );
    }
  }

  return resolved.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build compact CLAUDE/OpenClaw-style skill prompt metadata.
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  const promptCandidates = skills
    .filter((skill) => !skill.disableModelInvocation)
    .slice(0, MAX_SKILLS_IN_PROMPT);
  if (promptCandidates.length === 0) return '';

  const lines: string[] = [];
  const embeddedAlways = new Set<string>();
  const demotedAlways: Skill[] = [];

  let alwaysChars = 0;
  for (const skill of promptCandidates.filter(
    (candidate) => candidate.always,
  )) {
    const body = loadSkillBody(skill, Number.MAX_SAFE_INTEGER);
    if (!body) {
      demotedAlways.push(skill);
      continue;
    }
    const block = [
      `<skill_always name="${escapeXml(skill.name)}" path="${escapeXml(skill.location)}">`,
      body,
      '</skill_always>',
    ];
    const serialized = block.join('\n');
    if (alwaysChars + serialized.length > MAX_ALWAYS_CHARS) {
      demotedAlways.push(skill);
      continue;
    }
    lines.push(...block, '');
    alwaysChars += serialized.length;
    embeddedAlways.add(skill.name);
  }

  if (demotedAlways.length > 0) {
    const demotedNames = demotedAlways.map((skill) => skill.name).join(', ');
    lines.push(
      `⚠️ maxAlwaysChars=${MAX_ALWAYS_CHARS} exceeded; demoted to summary: ${demotedNames}`,
      '',
    );
  }

  const summaryCandidates = promptCandidates.filter(
    (skill) => !embeddedAlways.has(skill.name),
  );
  if (summaryCandidates.length > 0) {
    lines.push('<available_skills>');

    let chars = 0;
    for (const skill of summaryCandidates) {
      const block = [
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <description>${escapeXml(skill.description || skill.name)}</description>`,
        `    <location>${escapeXml(skill.location)}</location>`,
        '  </skill>',
      ];
      const serialized = block.join('\n');
      if (chars + serialized.length > MAX_SKILLS_PROMPT_CHARS) break;
      lines.push(...block);
      chars += serialized.length;
    }

    lines.push('</available_skills>');
  }

  return lines.join('\n').trim();
}
