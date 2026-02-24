/**
 * Skills — Claude-compatible SKILL.md loading.
 * Scans workspace/skills/ and project skills/ directories for SKILL.md files,
 * parses frontmatter, and builds a prompt section for the agent.
 *
 * Skill format (SKILL.md):
 * ---
 * name: skill-name
 * description: What the skill does
 * user-invocable: true
 * ---
 * # Instructions for the agent...
 */
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';
import { agentWorkspaceDir } from './ipc.js';

export interface Skill {
  name: string;
  description: string;
  userInvocable: boolean;
  content: string;
  path: string;
}

const MAX_SKILL_CHARS = 10_000;
const MAX_TOTAL_SKILLS_CHARS = 30_000;
const PROJECT_SKILLS_DIR = path.join(process.cwd(), 'skills');

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  if (!raw.startsWith('---')) return { meta, body: raw };

  const endIdx = raw.indexOf('---', 3);
  if (endIdx === -1) return { meta, body: raw };

  const frontmatter = raw.slice(3, endIdx).trim();
  const body = raw.slice(endIdx + 3).trim();

  for (const line of frontmatter.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    meta[key] = val;
  }

  return { meta, body };
}

function scanSkillsDir(dir: string): Skill[] {
  if (!fs.existsSync(dir)) return [];

  const skills: Skill[] = [];

  try {
    for (const entry of fs.readdirSync(dir)) {
      const entryPath = path.join(dir, entry);
      const stat = fs.statSync(entryPath);

      if (stat.isDirectory()) {
        const skillFile = path.join(entryPath, 'SKILL.md');
        if (fs.existsSync(skillFile)) {
          try {
            const raw = fs.readFileSync(skillFile, 'utf-8');
            const { meta, body } = parseFrontmatter(raw);

            const name = meta.name || entry;
            const description = meta.description || '';
            const userInvocable = meta['user-invocable'] !== 'false';

            let content = body;
            if (content.length > MAX_SKILL_CHARS) {
              content = content.slice(0, MAX_SKILL_CHARS) + '\n[truncated]';
            }

            skills.push({ name, description, userInvocable, content, path: skillFile });
          } catch (err) {
            logger.warn({ path: skillFile, err }, 'Failed to parse skill');
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ dir, err }, 'Failed to scan skills directory');
  }

  return skills;
}

/**
 * Load all skills from workspace and project directories.
 * Workspace skills take precedence over project skills.
 */
export function loadSkills(agentId: string): Skill[] {
  const wsSkillsDir = path.join(agentWorkspaceDir(agentId), 'skills');
  const wsSkills = scanSkillsDir(wsSkillsDir);
  const projectSkills = scanSkillsDir(PROJECT_SKILLS_DIR);

  // Workspace skills override project skills by name
  const byName = new Map<string, Skill>();
  for (const s of projectSkills) byName.set(s.name, s);
  for (const s of wsSkills) byName.set(s.name, s);

  return [...byName.values()];
}

/**
 * Build a prompt section listing available skills.
 */
export function buildSkillsPrompt(skills: Skill[]): string {
  if (skills.length === 0) return '';

  const lines: string[] = [
    '# Available Skills',
    '',
    'The following skills are available. Use them when relevant.',
    '',
  ];

  let totalChars = 0;

  const invocable = skills.filter((s) => s.userInvocable);
  if (invocable.length > 0) {
    lines.push('User-invocable skills (can be triggered with /skill-name):');
    lines.push(invocable.map((s) => `- /${s.name}: ${s.description}`).join('\n'));
    lines.push('');
  }

  for (const skill of skills) {
    if (totalChars >= MAX_TOTAL_SKILLS_CHARS) {
      lines.push(`[${skills.length - skills.indexOf(skill)} more skills truncated]`);
      break;
    }

    lines.push(`## Skill: ${skill.name}`, '');
    if (skill.description) lines.push(skill.description, '');
    lines.push(skill.content, '');

    totalChars += skill.content.length;
  }

  return lines.join('\n');
}
