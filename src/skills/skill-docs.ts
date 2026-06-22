import fs from 'node:fs';
import path from 'node:path';
import { resolveInstallPath } from '../infra/install-root.js';

export type SkillDocPromptKind = 'try-it' | 'conversation';

export interface SkillDocPrompt {
  prompt: string;
  kind: SkillDocPromptKind;
  turnIndex?: number;
  conversationId?: string;
}

export interface SkillDocScreenshot {
  src: string;
  alt: string;
  title?: string;
}

export interface SkillDocSection {
  title: string;
  sourcePath: string;
  sourceHref: string;
  tutorialMarkdown: string;
  examplePrompts: SkillDocPrompt[];
  screenshots: SkillDocScreenshot[];
}

const SECTION_HEADING_RE = /^##\s+(.+?)\s*$/;
const TRY_IT_YOURSELF_RE = /Try it yourself/i;
const CONVERSATION_FLOW_RE = /(Conversation flow|Multi-step flow)/i;
const BACKTICK_PROMPT_RE = /^\s*`([^`]+)`\s*$/;
const CONVERSATION_TURN_RE = /^\s*\d+[.)]\s*(.+)$/;
const MARKDOWN_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]+)")?\)/g;

export function resolveSkillDocsRoot(): string {
  return resolveInstallPath('docs', 'content', 'guides', 'skills');
}

function stripBlockquote(line: string): string | null {
  const match = line.match(/^\s*>\s?(.*)$/);
  return match ? match[1] : null;
}

function slugifyHeading(value: string): string {
  return value
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeHeadingSkillTokens(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/\band\b/g, ',')
    .split(',')
    .map((part) => part.trim())
    .map((part) => part.match(/[a-z0-9][a-z0-9._-]*/)?.[0] || '')
    .filter(Boolean);
}

function headingMatchesSkill(title: string, skillName: string): boolean {
  const normalizedSkillName = skillName.trim().toLowerCase();
  if (!normalizedSkillName) return false;
  return normalizeHeadingSkillTokens(title).includes(normalizedSkillName);
}

function parseExamplePrompts(
  skillName: string,
  lines: string[],
): SkillDocPrompt[] {
  const prompts: SkillDocPrompt[] = [];
  let mode: SkillDocPromptKind | 'idle' = 'idle';
  let conversationSeq = 0;
  let turnIndex = 0;

  for (const line of lines) {
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
      conversationSeq += 1;
      turnIndex = 0;
      continue;
    }

    if (mode === 'idle' || blockquote.trim() === '') continue;

    const promptMatch = blockquote.match(BACKTICK_PROMPT_RE);
    if (!promptMatch) continue;

    const prompt = promptMatch[1].trim();
    if (!prompt) continue;

    if (mode === 'conversation') {
      const turnMatch = prompt.match(CONVERSATION_TURN_RE);
      const normalizedPrompt = turnMatch ? turnMatch[1].trim() : prompt;
      if (!normalizedPrompt) continue;
      turnIndex += 1;
      prompts.push({
        prompt: normalizedPrompt,
        kind: 'conversation',
        turnIndex,
        conversationId: `${skillName}#conv${conversationSeq}`,
      });
      continue;
    }

    prompts.push({ prompt, kind: 'try-it' });
  }

  return prompts;
}

function resolveScreenshotSrc(sourcePath: string, rawSrc: string): string {
  if (/^(?:https?:)?\/\//.test(rawSrc) || rawSrc.startsWith('/')) {
    return rawSrc;
  }

  const baseDir = path.posix.dirname(sourcePath);
  return `/docs/${path.posix.normalize(path.posix.join(baseDir, rawSrc))}`;
}

function parseScreenshots(
  sourcePath: string,
  markdown: string,
): SkillDocScreenshot[] {
  const screenshots: SkillDocScreenshot[] = [];
  const seen = new Set<string>();

  for (const match of markdown.matchAll(MARKDOWN_IMAGE_RE)) {
    const rawSrc = match[2]?.trim();
    if (!rawSrc) continue;

    const src = resolveScreenshotSrc(sourcePath, rawSrc);
    if (seen.has(src)) continue;
    seen.add(src);

    const alt = match[1]?.trim() || 'Skill screenshot';
    const title = match[3]?.trim();
    screenshots.push({
      src,
      alt,
      ...(title ? { title } : {}),
    });
  }

  return screenshots;
}

function parseSkillDocFile(
  fileName: string,
  text: string,
): Array<{ skillNames: string[]; section: SkillDocSection }> {
  const lines = text.split(/\r?\n/);
  const sections: Array<{ skillNames: string[]; section: SkillDocSection }> =
    [];

  for (let index = 0; index < lines.length; index += 1) {
    const headingMatch = lines[index]?.match(SECTION_HEADING_RE);
    if (!headingMatch) continue;

    const title = headingMatch[1].trim();
    const skillNames = normalizeHeadingSkillTokens(title);
    if (skillNames.length === 0) continue;

    const bodyStart = index + 1;
    let bodyEnd = lines.length;
    for (let cursor = bodyStart; cursor < lines.length; cursor += 1) {
      if (SECTION_HEADING_RE.test(lines[cursor] || '')) {
        bodyEnd = cursor;
        break;
      }
    }

    const bodyLines = lines.slice(bodyStart, bodyEnd);
    const tutorialMarkdown = [`## ${title}`, ...bodyLines]
      .join('\n')
      .replace(/\n---\s*$/g, '')
      .trim();
    const sourcePath = `guides/skills/${fileName}`;
    const sourceHref = `/docs/guides/skills/${fileName.replace(/\.md$/, '')}#${slugifyHeading(title)}`;

    sections.push({
      skillNames,
      section: {
        title,
        sourcePath,
        sourceHref,
        tutorialMarkdown,
        examplePrompts: [],
        screenshots: parseScreenshots(sourcePath, tutorialMarkdown),
      },
    });
  }

  return sections.map((entry) => ({
    ...entry,
    section: {
      ...entry.section,
      examplePrompts: parseExamplePrompts(
        entry.skillNames[0] || '',
        entry.section.tutorialMarkdown.split(/\r?\n/),
      ),
    },
  }));
}

export function loadSkillDocsCatalog(
  docsRoot: string = resolveSkillDocsRoot(),
): Map<string, SkillDocSection> {
  const catalog = new Map<string, SkillDocSection>();
  if (!fs.existsSync(docsRoot)) return catalog;

  const files = fs
    .readdirSync(docsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name)
    .filter((fileName) => fileName.toLowerCase() !== 'readme.md')
    .sort((left, right) => left.localeCompare(right));

  for (const fileName of files) {
    const filePath = path.join(docsRoot, fileName);
    const text = fs.readFileSync(filePath, 'utf-8');
    for (const { skillNames, section } of parseSkillDocFile(fileName, text)) {
      for (const skillName of skillNames) {
        if (
          !catalog.has(skillName) &&
          headingMatchesSkill(section.title, skillName)
        ) {
          catalog.set(skillName, {
            ...section,
            examplePrompts: parseExamplePrompts(
              skillName,
              section.tutorialMarkdown.split(/\r?\n/),
            ),
          });
        }
      }
    }
  }

  return catalog;
}
