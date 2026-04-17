import fs from 'node:fs';
import path from 'node:path';

const SKILL_SEARCH_ROOTS = [
  'skills',
  'community-skills',
  'plugins',
];

function* walkSkillFiles(root) {
  if (!fs.existsSync(root)) return;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        stack.push(full);
        continue;
      }
      if (entry.name === 'SKILL.md') yield full;
    }
  }
}

function parseFrontmatter(raw) {
  if (!raw.startsWith('---')) {
    return { frontmatter: '', body: raw, fields: {} };
  }
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { frontmatter: '', body: raw, fields: {} };
  const frontmatter = raw.slice(3, end).replace(/^\n/, '').replace(/\n$/, '');
  const body = raw.slice(end + 4).replace(/^\n/, '');
  const fields = {};
  for (const line of frontmatter.split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    const trimmed = rawValue.trim();
    if (!trimmed) continue;
    const unquoted = trimmed.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    fields[key] = unquoted;
  }
  return { frontmatter, body, fields };
}

export function findSkill(skillName, repoRoot) {
  const normalized = String(skillName || '').trim();
  if (!normalized) return null;

  for (const rel of SKILL_SEARCH_ROOTS) {
    const root = path.join(repoRoot, rel);
    for (const filePath of walkSkillFiles(root)) {
      if (path.basename(path.dirname(filePath)) === normalized) {
        return filePath;
      }
    }
  }

  for (const rel of SKILL_SEARCH_ROOTS) {
    const root = path.join(repoRoot, rel);
    for (const filePath of walkSkillFiles(root)) {
      try {
        const head = fs.readFileSync(filePath, 'utf-8').slice(0, 1024);
        const { fields } = parseFrontmatter(head);
        if (fields.name === normalized) return filePath;
      } catch {
        continue;
      }
    }
  }

  return null;
}

export function loadSkill(skillPath) {
  const raw = fs.readFileSync(skillPath, 'utf-8');
  const { frontmatter, body, fields } = parseFrontmatter(raw);
  return {
    path: skillPath,
    raw,
    frontmatter,
    body,
    name: fields.name || path.basename(path.dirname(skillPath)),
    description: fields.description || '',
    fields,
  };
}

export function listAllSkills(repoRoot) {
  const skills = [];
  for (const rel of SKILL_SEARCH_ROOTS) {
    const root = path.join(repoRoot, rel);
    for (const filePath of walkSkillFiles(root)) {
      try {
        const skill = loadSkill(filePath);
        skills.push({
          name: skill.name,
          description: skill.description,
          path: filePath,
          bodyBytes: Buffer.byteLength(skill.body, 'utf-8'),
        });
      } catch {
        continue;
      }
    }
  }
  return skills;
}
