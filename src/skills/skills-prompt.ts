/**
 * Skill catalog for the system prompt: names, descriptions and where to read
 * each SKILL.md, held under maxSkillsPromptChars by shortening descriptions
 * before leaving skills out. `always` skills are inlined in full instead.
 * The catalog is a routing hint only; skills_list stays the complete
 * directory, and this module never decides which skills are eligible.
 */
import { logger } from '../logger.js';
import { loadSkillBody, type Skill } from './skills.js';

const MAX_SKILLS_PROMPT_CHARS = 30_000;
const MAX_ALWAYS_CHARS = 10_000;

/**
 * `xml` is the default catalog. `lines` is about half its size, one
 * `- name [category]: description` line per skill, for clients that need a short prompt.
 */
export type SkillListFormatName = 'xml' | 'lines';

interface SkillListFormat {
  open: string;
  close: string;
  /** Escapes skill metadata; must map each character on its own. */
  escape: (text: string) => string;
  /** Renders one skill; an empty description leaves the description out. */
  render: (skill: Skill, description: string) => string;
  /** Characters a non-empty description adds besides its own text. */
  descriptionChars: number;
  notice: (compactedDescriptions: number, omittedSkills: number) => string;
  /** The rules that name the catalog's fields. */
  scanRule: string;
  namedRule: string;
  readRule: string;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Keeps a description on its line, so it cannot pass for another entry or rule. */
function flattenLine(text: string): string {
  return text.replace(/\s/g, ' ');
}

const SKILL_LIST_FORMATS: Record<SkillListFormatName, SkillListFormat> = {
  xml: {
    open: '<available_skills>',
    close: '</available_skills>',
    escape: escapeXml,
    render: (skill, description) =>
      [
        '  <skill>',
        `    <name>${escapeXml(skill.name)}</name>`,
        `    <category>${escapeXml(skill.category)}</category>`,
        ...(description
          ? [`    <description>${description}</description>`]
          : []),
        `    <location>${escapeXml(skill.location)}</location>`,
        '  </skill>',
      ].join('\n'),
    descriptionChars: '\n    <description></description>'.length,
    notice: (compactedDescriptions, omittedSkills) =>
      `  <skills_catalog_notice compacted_descriptions="${compactedDescriptions}" omitted_skills="${omittedSkills}">Catalog constrained by maxSkillsPromptChars=${MAX_SKILLS_PROMPT_CHARS}. Use skills_list to search the complete eligible catalog.</skills_catalog_notice>`,
    scanRule:
      'Before replying: scan `<available_skills>` `<name>`, `<category>`, and `<description>` entries.',
    namedRule:
      '- If the user explicitly names a skill from `<available_skills>`, treat that skill as selected.',
    readRule:
      '- If exactly one skill clearly applies: read its SKILL.md at `<location>` with `read`, then follow it.',
  },
  lines: {
    open: 'Available skills (default location: skills/<name>/SKILL.md):',
    close: '',
    escape: flattenLine,
    render: (skill, description) => {
      // The path is shown only where it differs from the rule's default.
      const path =
        skill.location === `skills/${skill.name}/SKILL.md`
          ? ''
          : ` (${flattenLine(skill.location)})`;
      return `- ${flattenLine(skill.name)} [${flattenLine(skill.category)}]${path}${description ? `: ${description}` : ''}`;
    },
    descriptionChars: ': '.length,
    notice: (compactedDescriptions, omittedSkills) =>
      `(${compactedDescriptions} descriptions shortened and ${omittedSkills} skills left out to fit the prompt. Use skills_list to search the complete eligible catalog.)`,
    scanRule:
      'Before replying: scan the skill list below. Each line is `- name [category]: description`.',
    namedRule:
      '- If the user explicitly names a listed skill, treat that skill as selected.',
    readRule:
      '- If exactly one skill clearly applies: read `skills/<name>/SKILL.md` with `read` (or the path in parentheses after its name, when shown), then follow it.',
  },
};

/**
 * Build compact CLAUDE/OpenClaw-style skill prompt metadata.
 */
export function buildSkillsPrompt(
  skills: Skill[],
  formatName: SkillListFormatName = 'xml',
): string {
  const format = SKILL_LIST_FORMATS[formatName];
  const promptCandidates = skills.filter(
    (skill) => !skill.disableModelInvocation,
  );
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
    lines.push(format.open);

    // Escape once per skill: the binary search below probes the rendered size
    // O(log maxDescriptionLength) times and must not re-escape the catalog on
    // every probe. buildSkillsPrompt runs on every prompt build.
    const summaries = summaryCandidates.map((skill) => {
      const rawDescription = skill.description || skill.name;
      return {
        skill,
        rawDescription,
        escapedDescription: format.escape(rawDescription),
        identityChars: format.render(skill, '').length,
      };
    });
    type SkillSummary = (typeof summaries)[number];

    /** Truncate on raw characters so an escape sequence is never split. */
    const compactDescription = (summary: SkillSummary, limit: number) => {
      if (limit <= 0) return '';
      if (summary.escapedDescription.length <= limit) {
        return summary.escapedDescription;
      }
      if (limit === 1) return '…';
      let compacted = '';
      for (const character of summary.rawDescription) {
        const escapedCharacter = format.escape(character);
        if (compacted.length + escapedCharacter.length + 1 > limit) break;
        compacted += escapedCharacter;
      }
      return `${compacted}…`;
    };

    // Upper bound of the rendered size at a given limit, computed arithmetically
    // instead of by rendering: compactDescription never returns more than
    // `limit` characters, so overshooting only picks a slightly tighter limit.
    const projectedLength = (descriptionLimit: number) =>
      summaries.reduce(
        (total, summary) =>
          total +
          summary.identityChars +
          (descriptionLimit > 0
            ? format.descriptionChars +
              Math.min(summary.escapedDescription.length, descriptionLimit)
            : 0),
        0,
      );

    const maxDescriptionLength = summaries.reduce(
      (max, summary) => Math.max(max, summary.escapedDescription.length),
      0,
    );
    let descriptionLimit = maxDescriptionLength;
    if (projectedLength(descriptionLimit) > MAX_SKILLS_PROMPT_CHARS) {
      let low = 0;
      let high = maxDescriptionLength;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (projectedLength(middle) <= MAX_SKILLS_PROMPT_CHARS) low = middle;
        else high = middle - 1;
      }
      descriptionLimit = low;
    }

    let chars = 0;
    let includedCount = 0;
    for (const summary of summaries) {
      const serialized = format.render(
        summary.skill,
        compactDescription(summary, descriptionLimit),
      );
      // The binary search bottoms out at descriptionLimit = 0 without being able
      // to guarantee a fit, so identity-only blocks can still overflow. Skip
      // those instead of breaking, and report them as omitted below.
      if (chars + serialized.length > MAX_SKILLS_PROMPT_CHARS) continue;
      lines.push(serialized);
      chars += serialized.length;
      includedCount += 1;
    }

    const compactedDescriptions = summaries.filter(
      (summary) => descriptionLimit < summary.escapedDescription.length,
    ).length;
    const omittedSkills = summaryCandidates.length - includedCount;
    if (compactedDescriptions > 0 || omittedSkills > 0) {
      lines.push(format.notice(compactedDescriptions, omittedSkills));
      logger.warn(
        {
          eligibleSkills: summaryCandidates.length,
          includedSkills: includedCount,
          compactedDescriptions,
          omittedSkills,
          maxSkillsPromptChars: MAX_SKILLS_PROMPT_CHARS,
        },
        'Compacted skill catalog for system prompt',
      );
    }

    if (format.close) lines.push(format.close);
  }

  return lines.join('\n').trim();
}

/** The skill catalog with the rules for choosing and reading a skill. */
export function buildSkillsSection(
  skills: Skill[],
  formatName: SkillListFormatName = 'xml',
): string {
  const format = SKILL_LIST_FORMATS[formatName];
  const catalog = buildSkillsPrompt(skills, formatName);
  if (!catalog) return '';
  if (!catalog.includes(format.open)) return catalog;

  return [
    '## Skills (mandatory)',
    format.scanRule,
    '- A skill is instruction text, not a directly callable tool/function. Do not try to invoke a skill by name.',
    format.namedRule,
    format.readRule,
    '- After reading SKILL.md, use ordinary available tools such as `bash`, `read`, or `http_request` exactly as the skill instructs.',
    '- If multiple could apply: choose the most specific one, then read/follow it.',
    '- Treat direct format-name matches like "PDF", "DOCX", "XLSX", and "PPTX" as strong evidence for the same-named skill when the request is to create, edit, inspect, extract, or convert that format.',
    '- If none clearly apply: do not read any SKILL.md.',
    '- Do not claim a listed skill is unavailable when the user named it.',
    '- Treat paths under `skills/` as bundled, read-only skill assets for normal user work.',
    '- For normal user work, put generated scripts in workspace `scripts/` or the workspace root. Only write under `skills/` when the user explicitly asked to create or edit a skill.',
    '- Before running a helper under `skills/.../scripts/...`, make sure that exact path came from the skill instructions or from a file read/listing in this turn. Do not invent helper names or guess that a sibling script exists.',
    '- Run documented skill helper commands exactly as shown unless the skill explicitly says to modify them. Do not add Node permission flags such as `--experimental-permission`, and do not rewrite `skills/...` helper paths to `/workspace/skills/...`.',
    '',
    catalog,
  ].join('\n');
}
