/**
 * Skills — CLAUDE/OpenClaw-compatible SKILL.md discovery.
 * The system prompt only includes skill metadata + location; the model reads
 * SKILL.md on demand with the `read` tool.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createHash } from 'crypto';

import { agentWorkspaceDir } from './ipc.js';
import { logger } from './logger.js';

type SkillSource = 'workspace' | 'project' | 'codex' | 'claude';

interface SkillCandidate {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  filePath: string;
  baseDir: string;
  source: SkillSource;
}

export interface Skill {
  name: string;
  description: string;
  userInvocable: boolean;
  disableModelInvocation: boolean;
  filePath: string;
  baseDir: string;
  source: SkillSource;
  location: string;
}

const PROJECT_SKILLS_DIR = path.join(process.cwd(), 'skills');
const SYNCED_SKILLS_DIR = '.synced-skills';
const MAX_SKILLS_IN_PROMPT = 150;
const MAX_SKILLS_PROMPT_CHARS = 30_000;
const MAX_INVOKED_SKILL_CHARS = 35_000;

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

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const normalized = normalizeLineEndings(raw);
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) {
    return { meta: {}, body: normalized.trim() };
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

  return { meta, body };
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

function pathWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function asContainerPath(workspaceDir: string, absolutePath: string): string | null {
  if (!pathWithin(workspaceDir, absolutePath)) return null;
  const rel = toPosixPath(path.relative(workspaceDir, absolutePath));
  return rel ? `/workspace/${rel}` : '/workspace';
}

function resolveManagedSkillsDirs(): Array<{ source: SkillSource; dir: string }> {
  const home = os.homedir();
  const dirs: Array<{ source: SkillSource; dir: string }> = [
    { source: 'codex', dir: path.join(home, '.codex', 'skills') },
    { source: 'claude', dir: path.join(home, '.claude', 'skills') },
  ];

  const codexHome = process.env.CODEX_HOME?.trim();
  if (codexHome) {
    dirs.unshift({ source: 'codex', dir: path.join(codexHome, 'skills') });
  }

  const seen = new Set<string>();
  return dirs.filter(({ dir }) => {
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
        const { meta } = parseFrontmatter(raw);
        const name = (meta.name || entry.name).trim();
        if (!name) continue;

        skills.push({
          name,
          description: (meta.description || '').trim(),
          userInvocable: parseBool(meta['user-invocable'], true),
          disableModelInvocation: parseBool(meta['disable-model-invocation'], false),
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

function resolveSyncedSkillTarget(
  skill: SkillCandidate,
  workspaceDir: string,
): { rootDir: string; targetDir: string; targetSkillFile: string } {
  // Keep project skills under /workspace/skills so script paths like
  // "skills/<skill>/scripts/..." remain valid inside the agent container.
  if (skill.source === 'project') {
    const projectRoot = path.resolve(PROJECT_SKILLS_DIR);
    const skillBaseDir = path.resolve(skill.baseDir);
    if (pathWithin(projectRoot, skillBaseDir)) {
      const rel = path.relative(projectRoot, skillBaseDir);
      const rootDir = path.join(workspaceDir, 'skills');
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

function syncSkillIntoWorkspace(skill: SkillCandidate, workspaceDir: string): string {
  const { rootDir, targetDir, targetSkillFile } = resolveSyncedSkillTarget(skill, workspaceDir);
  fs.mkdirSync(rootDir, { recursive: true });

  if (!pathWithin(rootDir, targetDir)) {
    throw new Error(`Unsafe synced skill path: ${targetDir}`);
  }

  let shouldSync = true;
  try {
    if (fs.existsSync(targetSkillFile)) {
      const srcStat = fs.statSync(skill.filePath);
      const dstStat = fs.statSync(targetSkillFile);
      shouldSync = dstStat.mtimeMs < srcStat.mtimeMs;
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

function normalizeSkillLookup(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-');
}

function findInvocableSkill(skills: Skill[], rawName: string): Skill | null {
  const target = rawName.trim().toLowerCase();
  if (!target) return null;
  const normalizedTarget = normalizeSkillLookup(rawName);
  return skills.find((skill) => {
    if (!skill.userInvocable) return false;
    const name = skill.name.toLowerCase();
    if (name === target) return true;
    return normalizeSkillLookup(skill.name) === normalizedTarget;
  }) || null;
}

function parseSkillInvocation(content: string, skills: Skill[]): { skill: Skill; args: string } | null {
  const trimmed = content.trim();
  if (!trimmed.startsWith('/')) return null;

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
    const skill = findInvocableSkill(skills, skillMatch[1] || '');
    if (!skill) return null;
    return { skill, args: (skillMatch[2] || '').trim() };
  }

  if (lowerCommand.startsWith('skill:')) {
    const skillName = lowerCommand.slice('skill:'.length).trim();
    if (!skillName) return null;
    const skill = findInvocableSkill(skills, skillName);
    if (!skill) return null;
    return { skill, args: remainder };
  }

  const directSkill = findInvocableSkill(skills, commandName);
  if (!directSkill) return null;
  return { skill: directSkill, args: remainder };
}

function loadSkillBody(skill: Skill): string {
  try {
    const raw = fs.readFileSync(skill.filePath, 'utf-8');
    const { body } = parseFrontmatter(raw);
    if (body.length <= MAX_INVOKED_SKILL_CHARS) return body;
    return `${body.slice(0, MAX_INVOKED_SKILL_CHARS)}\n\n[truncated]`;
  } catch (err) {
    logger.warn({ skill: skill.name, path: skill.filePath, err }, 'Failed to load SKILL.md body');
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
export function expandSkillInvocation(content: string, skills: Skill[]): string {
  const invocation = parseSkillInvocation(content, skills);
  if (!invocation) return content;

  const body = loadSkillBody(invocation.skill);
  const args = invocation.args || '(none)';

  const lines = [
    `[Explicit skill invocation] Use the "${invocation.skill.name}" skill for this request.`,
    `Skill file: ${invocation.skill.location}`,
    `Skill input: ${args}`,
  ];

  if (body) {
    lines.push(
      '',
      '<skill_instructions>',
      body,
      '</skill_instructions>',
    );
  } else {
    lines.push('Read the skill file with the `read` tool and follow it.');
  }

  return lines.join('\n');
}

/**
 * Load all skills with precedence:
 * codex/claude managed < project skills < agent workspace skills.
 * Any non-workspace skill selected by precedence is mirrored into workspace so
 * the container can read it via /workspace/... paths.
 */
export function loadSkills(agentId: string): Skill[] {
  const workspaceDir = path.resolve(agentWorkspaceDir(agentId));
  fs.mkdirSync(workspaceDir, { recursive: true });

  const workspaceSkills = scanSkillsDir(path.join(workspaceDir, 'skills'), 'workspace');
  const projectSkills = scanSkillsDir(PROJECT_SKILLS_DIR, 'project');
  const managedSkills = resolveManagedSkillsDirs()
    .flatMap(({ source, dir }) => scanSkillsDir(dir, source));

  const byName = new Map<string, SkillCandidate>();

  // Lowest to highest precedence.
  for (const skill of managedSkills) byName.set(skill.name, skill);
  for (const skill of projectSkills) byName.set(skill.name, skill);
  for (const skill of workspaceSkills) byName.set(skill.name, skill);

  const resolved: Skill[] = [];
  for (const skill of byName.values()) {
    try {
      let containerSkillPath = asContainerPath(workspaceDir, path.resolve(skill.filePath));
      if (!containerSkillPath) {
        const syncedSkillFile = syncSkillIntoWorkspace(skill, workspaceDir);
        containerSkillPath = asContainerPath(workspaceDir, path.resolve(syncedSkillFile));
      }
      if (!containerSkillPath) {
        logger.warn({ skill: skill.name, path: skill.filePath }, 'Could not resolve container-readable skill path');
        continue;
      }

      resolved.push({
        ...skill,
        location: containerSkillPath,
      });
    } catch (err) {
      logger.warn({ skill: skill.name, err }, 'Failed to resolve skill location');
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

  const lines: string[] = [
    '## Skills (mandatory)',
    'Before replying: scan <available_skills> <description> entries.',
    '- If exactly one skill clearly applies: read its SKILL.md at <location> with `read`, then follow it.',
    '- If multiple could apply: choose the most specific one, then read/follow it.',
    '- If none clearly apply: do not read any SKILL.md.',
    'Constraints: never read more than one skill up front; only read after selecting.',
    '',
    '<available_skills>',
  ];

  let chars = 0;
  for (const skill of promptCandidates) {
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
  return lines.join('\n');
}
