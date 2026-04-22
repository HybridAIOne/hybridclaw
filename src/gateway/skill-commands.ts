import type { SkillConfigChannelKind } from '../channels/channel.js';
import { SKILL_CONFIG_CHANNEL_KINDS } from '../channels/channel.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import {
  getRuntimeSkillScopeDisabledNames,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import type {
  SkillAmendment,
  SkillHealthMetrics,
  SkillObservation,
} from '../skills/adaptive-skills-types.js';
import { parseSkillImportArgs } from '../skills/skill-import-args.js';
import { buildGuardWarningLines } from '../skills/skill-import-warnings.js';
import type { GatewayCommandResult } from './gateway-types.js';

const SKILL_COMMAND_USAGE =
  'Usage: `skill list|enable <name> [--channel <kind>]|disable <name> [--channel <kind>]|inspect <name>|inspect --all|runs <name>|install <skill> <dependency>|setup <skill>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>`';
const SKILL_LIST_LINE_MAX_CHARS = 113;

interface SkillCommandContext {
  args: string[];
  sessionAgentId: string;
  guildId: string | null;
  channelId: string;
  badCommand: (title: string, text: string) => GatewayCommandResult;
  infoCommand: (title: string, text: string) => GatewayCommandResult;
  plainCommand: (text: string) => GatewayCommandResult;
}

function isLocalSession(context: SkillCommandContext): boolean {
  return (
    context.guildId === null &&
    (context.channelId === 'web' || context.channelId === 'tui')
  );
}

function isForeignSkillSource(source: string): boolean {
  return (
    source === 'codex' ||
    source === 'claude' ||
    source === 'agents-personal' ||
    source === 'agents-project'
  );
}

function formatSkillCategoryLabel(category: string): string {
  const normalized = String(category || '').trim();
  if (!normalized) return 'Uncategorized';
  return normalized
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function truncateSkillListDescription(
  prefix: string,
  description: string,
  maxChars = SKILL_LIST_LINE_MAX_CHARS,
): string {
  const normalized = String(description || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return '';
  const available = maxChars - prefix.length - 3;
  if (available <= 0) return '';
  if (normalized.length <= available) return normalized;
  if (available <= 3) return '.'.repeat(available);
  return `${normalized.slice(0, available - 3).trimEnd()}...`;
}

function formatRatioAsPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function formatSkillHealthMetrics(metrics: SkillHealthMetrics): string {
  const lines = [
    `Skill: ${metrics.skill_name}`,
    `Executions: ${metrics.total_executions}`,
    `Success rate: ${formatRatioAsPercent(metrics.success_rate)}`,
    `Avg duration: ${Math.round(metrics.avg_duration_ms)}ms`,
    `Tool breakage: ${formatRatioAsPercent(metrics.tool_breakage_rate)}`,
    `Positive feedback: ${metrics.positive_feedback_count}`,
    `Negative feedback: ${metrics.negative_feedback_count}`,
    `Degraded: ${metrics.degraded ? 'yes' : 'no'}`,
  ];
  if (metrics.degradation_reasons.length > 0) {
    lines.push(`Reasons: ${metrics.degradation_reasons.join('; ')}`);
  }
  if (metrics.error_clusters.length > 0) {
    lines.push(
      `Error clusters: ${metrics.error_clusters
        .map((cluster) =>
          cluster.sample_detail
            ? `${cluster.category}=${cluster.count} (${cluster.sample_detail})`
            : `${cluster.category}=${cluster.count}`,
        )
        .join('; ')}`,
    );
  }
  return lines.join('\n');
}

function formatSkillAmendment(amendment: SkillAmendment): string {
  const lines = [
    `Version: ${amendment.version}`,
    `Status: ${amendment.status}`,
    `Guard: ${amendment.guard_verdict} (${amendment.guard_findings_count} finding(s))`,
    `Runs since apply: ${amendment.runs_since_apply}`,
    `Created: ${amendment.created_at}`,
  ];
  if (amendment.reviewed_by) {
    lines.push(`Reviewed by: ${amendment.reviewed_by}`);
  }
  if (amendment.rationale) {
    lines.push(`Rationale: ${amendment.rationale}`);
  }
  if (amendment.diff_summary) {
    lines.push(`Diff: ${amendment.diff_summary}`);
  }
  return lines.join('\n');
}

function formatSkillObservationRun(observation: SkillObservation): string {
  const lines = [
    `Run: ${observation.run_id}`,
    `Outcome: ${observation.outcome}`,
    `Observed: ${observation.created_at}`,
    `Duration: ${observation.duration_ms}ms`,
    `Tools: ${observation.tool_calls_failed}/${observation.tool_calls_attempted} failed`,
  ];
  if (observation.feedback_sentiment) {
    lines.push(`Feedback: ${observation.feedback_sentiment}`);
  }
  if (observation.user_feedback) {
    lines.push(`Feedback note: ${observation.user_feedback}`);
  }
  if (observation.error_category) {
    lines.push(`Error category: ${observation.error_category}`);
  }
  if (observation.error_detail) {
    lines.push(`Error detail: ${observation.error_detail}`);
  }
  return lines.join('\n');
}

export async function handleSkillCommand(
  context: SkillCommandContext,
): Promise<GatewayCommandResult> {
  const sub = (context.args[1] || '').trim().toLowerCase();
  if (!sub) {
    return context.badCommand('Usage', SKILL_COMMAND_USAGE);
  }

  if (sub === 'list') {
    const { listSkillCatalogEntries } = await import(
      '../skills/skills-management.js'
    );
    const catalog = listSkillCatalogEntries();
    if (catalog.length === 0) {
      return context.plainCommand('No skills are available.');
    }
    const lines: string[] = [];
    let hasForeignSkills = false;
    let currentCategory = '';
    for (const skill of catalog) {
      const category = formatSkillCategoryLabel(skill.category);
      if (category !== currentCategory) {
        if (currentCategory) lines.push('');
        currentCategory = category;
        lines.push(`${category}:`);
      }
      const foreignMarker = isForeignSkillSource(skill.source) ? '*' : '';
      if (foreignMarker) hasForeignSkills = true;
      const availability = skill.available
        ? skill.enabled
          ? 'available'
          : 'disabled'
        : skill.missing.join(', ');
      const prefix = `  ${skill.name}${foreignMarker} [${availability}]`;
      const listDescription =
        skill.metadata.hybridclaw.shortDescription || skill.description;
      const description = truncateSkillListDescription(prefix, listDescription);
      lines.push(`${prefix}${description ? ` — ${description}` : ''}`);
      if (skill.installs.length > 0) {
        const installs = skill.installs
          .map((install) => {
            const label = install.label ? ` — ${install.label}` : '';
            return `${install.id} (${install.kind})${label}`;
          })
          .join('; ');
        lines.push(`    installs: ${installs}`);
      }
    }
    if (hasForeignSkills) {
      lines.push('', '* foreign skill source');
    }
    return context.infoCommand('Skills', lines.join('\n'));
  }

  if (sub === 'enable' || sub === 'disable') {
    const rest = context.args.slice(2);
    const usageMessage = `Usage: \`skill ${sub} <name> [--channel <kind>]\``;
    let skillName: string | undefined;
    let channelKind: SkillConfigChannelKind | undefined;
    const resolveChannelKind = (
      raw: string,
    ): SkillConfigChannelKind | undefined | 'invalid' => {
      const trimmed = String(raw || '').trim();
      if (!trimmed || trimmed.toLowerCase() === 'global') {
        return undefined;
      }
      const normalized = normalizeSkillConfigChannelKind(trimmed);
      if (!normalized) {
        return 'invalid';
      }
      return normalized;
    };

    for (let i = 0; i < rest.length; i += 1) {
      const arg = String(rest[i] || '').trim();
      if (arg === '--channel') {
        const next = String(rest[i + 1] || '').trim();
        if (!next) {
          return context.badCommand(
            'Usage',
            `Missing value for \`--channel\`. Valid kinds: ${SKILL_CONFIG_CHANNEL_KINDS.join(', ')}, global`,
          );
        }
        const resolved = resolveChannelKind(next);
        if (resolved === 'invalid') {
          return context.badCommand(
            'Usage',
            `Invalid channel kind: ${next}. Valid kinds: ${SKILL_CONFIG_CHANNEL_KINDS.join(', ')}, global`,
          );
        }
        channelKind = resolved;
        i += 1;
        continue;
      }
      if (arg.startsWith('--channel=')) {
        const value = arg.slice('--channel='.length);
        const resolved = resolveChannelKind(value);
        if (resolved === 'invalid') {
          return context.badCommand(
            'Usage',
            `Invalid channel kind: ${value}. Valid kinds: ${SKILL_CONFIG_CHANNEL_KINDS.join(', ')}, global`,
          );
        }
        channelKind = resolved;
        continue;
      }
      if (arg.startsWith('-')) {
        return context.badCommand('Usage', `Unknown flag: ${arg}`);
      }
      if (skillName !== undefined) {
        return context.badCommand('Usage', usageMessage);
      }
      skillName = arg;
    }
    if (!skillName) {
      return context.badCommand('Usage', usageMessage);
    }

    const { loadSkillCatalog } = await import('../skills/skills.js');
    const known = loadSkillCatalog().some((skill) => skill.name === skillName);
    if (!known) {
      return context.badCommand('Unknown Skill', `Unknown skill: ${skillName}`);
    }

    const enabled = sub === 'enable';
    const nextConfig = updateRuntimeConfig((draft) => {
      setRuntimeSkillScopeEnabled(draft, skillName, enabled, channelKind);
    });
    const scope = channelKind ?? 'global';
    const lines = [
      `${enabled ? 'Enabled' : 'Disabled'} \`${skillName}\` in ${scope} scope.`,
    ];
    if (
      channelKind &&
      enabled &&
      getRuntimeSkillScopeDisabledNames(nextConfig).has(skillName)
    ) {
      lines.push(`\`${skillName}\` remains globally disabled.`);
    }
    return context.plainCommand(lines.join('\n'));
  }

  if (sub === 'inspect') {
    const inspectionModule = await import('../skills/skills-inspection.js');
    const target = String(context.args[2] || '').trim();
    if (!target) {
      return context.badCommand(
        'Usage',
        'Usage: `skill inspect <name>` or `skill inspect --all`',
      );
    }
    if (target === '--all' || target.toLowerCase() === 'all') {
      const metricsList = inspectionModule.inspectAllSkills();
      if (metricsList.length === 0) {
        return context.plainCommand(
          'No observed skills found in the current inspection window.',
        );
      }
      return context.infoCommand(
        'Skill Health',
        metricsList.map(formatSkillHealthMetrics).join('\n\n'),
      );
    }

    const metrics = inspectionModule.inspectSkill(target);
    if (metrics.total_executions === 0) {
      return context.plainCommand(`No observations found for \`${target}\`.`);
    }
    return context.infoCommand(
      'Skill Health',
      formatSkillHealthMetrics(metrics),
    );
  }

  if (sub === 'learn') {
    const skillName = String(context.args[2] || '').trim();
    if (!skillName) {
      return context.badCommand(
        'Usage',
        'Usage: `skill learn <name> [--apply|--reject|--rollback]`',
      );
    }

    const actions = new Set(
      context.args
        .slice(3)
        .map((entry) =>
          String(entry || '')
            .trim()
            .toLowerCase(),
        )
        .filter(Boolean),
    );
    const hasApply = actions.has('--apply') || actions.has('apply');
    const hasReject = actions.has('--reject') || actions.has('reject');
    const hasRollback = actions.has('--rollback') || actions.has('rollback');
    const selectedActions = [hasApply, hasReject, hasRollback].filter(
      Boolean,
    ).length;
    if (selectedActions > 1) {
      return context.badCommand(
        'Usage',
        'Choose at most one amendment action: `--apply`, `--reject`, or `--rollback`.',
      );
    }

    const dbModule = await import('../memory/db.js');
    const amendmentModule = await import('../skills/skills-amendment.js');
    const evaluationModule = await import('../skills/skills-evaluation.js');
    const inspectionModule = await import('../skills/skills-inspection.js');

    if (hasApply) {
      const amendment = dbModule.getLatestSkillAmendment({
        skillName,
        status: 'staged',
      });
      if (!amendment) {
        return context.plainCommand(
          `No staged amendment found for \`${skillName}\`.`,
        );
      }
      const result = await amendmentModule.applyAmendment({
        amendmentId: amendment.id,
        reviewedBy: 'gateway-command',
      });
      if (!result.ok) {
        return context.badCommand(
          'Apply Failed',
          result.reason || 'Failed to apply amendment.',
        );
      }
      return context.plainCommand(
        `Applied staged amendment v${amendment.version} for \`${skillName}\`.`,
      );
    }

    if (hasReject) {
      const amendment = dbModule.getLatestSkillAmendment({
        skillName,
        status: 'staged',
      });
      if (!amendment) {
        return context.plainCommand(
          `No staged amendment found for \`${skillName}\`.`,
        );
      }
      const result = amendmentModule.rejectAmendment({
        amendmentId: amendment.id,
        reviewedBy: 'gateway-command',
      });
      if (!result.ok) {
        return context.badCommand(
          'Reject Failed',
          result.reason || 'Failed to reject amendment.',
        );
      }
      return context.plainCommand(
        `Rejected staged amendment v${amendment.version} for \`${skillName}\`.`,
      );
    }

    if (hasRollback) {
      const amendment = dbModule.getLatestSkillAmendment({
        skillName,
        status: 'applied',
      });
      if (!amendment) {
        return context.plainCommand(
          `No applied amendment found for \`${skillName}\`.`,
        );
      }
      const result = await evaluationModule.rollbackAmendment({
        amendmentId: amendment.id,
        reason: 'Rollback requested via gateway command.',
      });
      if (!result.ok) {
        return context.badCommand(
          'Rollback Failed',
          result.reason || 'Failed to roll back amendment.',
        );
      }
      return context.plainCommand(
        `Rolled back amendment v${amendment.version} for \`${skillName}\`.`,
      );
    }

    const metrics = inspectionModule.inspectSkill(skillName);
    if (metrics.total_executions === 0) {
      return context.plainCommand(
        `No observations found for \`${skillName}\`; run the skill first before proposing an amendment.`,
      );
    }
    const amendment = await amendmentModule.proposeAmendment({
      skillName,
      metrics,
      agentId: context.sessionAgentId,
    });
    return context.infoCommand(
      `Skill Amendment (${skillName})`,
      formatSkillAmendment(amendment),
    );
  }

  if (sub === 'history') {
    const skillName = String(context.args[2] || '').trim();
    if (!skillName) {
      return context.badCommand('Usage', 'Usage: `skill history <name>`');
    }
    const dbModule = await import('../memory/db.js');
    const history = dbModule.getAmendmentHistory(skillName);
    if (history.length === 0) {
      return context.plainCommand(
        `No amendment history found for \`${skillName}\`.`,
      );
    }
    return context.infoCommand(
      `Skill History (${skillName})`,
      history.map(formatSkillAmendment).join('\n\n'),
    );
  }

  if (sub === 'runs') {
    const skillName = String(context.args[2] || '').trim();
    if (!skillName) {
      return context.badCommand('Usage', 'Usage: `skill runs <name>`');
    }
    const { getSkillExecutionRuns } = await import(
      '../skills/skills-management.js'
    );
    const runs = getSkillExecutionRuns(skillName);
    if (runs.length === 0) {
      return context.plainCommand(
        `No observations found for \`${skillName}\`.`,
      );
    }
    return context.infoCommand(
      `Skill Runs (${skillName})`,
      runs.map(formatSkillObservationRun).join('\n\n'),
    );
  }

  if (sub === 'install') {
    const skillName = String(context.args[2] || '').trim();
    const installId = String(context.args[3] || '').trim() || undefined;
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Install Restricted',
        '`skill install` is only available from local TUI/web sessions.',
      );
    }
    if (!skillName || !installId) {
      return context.badCommand(
        'Usage',
        'Usage: `skill install <skill> <dependency>`',
      );
    }

    const { installSkillDependency } = await import(
      '../skills/skills-install.js'
    );
    const result = await installSkillDependency({ skillName, installId });
    const lines = [result.message];
    if (result.stdout) {
      lines.push('', 'stdout:', result.stdout);
    }
    if (result.stderr) {
      lines.push('', 'stderr:', result.stderr);
    }
    return result.ok
      ? context.infoCommand('Skill Installed', lines.join('\n'))
      : context.badCommand('Skill Install Failed', lines.join('\n'));
  }

  if (sub === 'setup') {
    const skillName = String(context.args[2] || '').trim();
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Setup Restricted',
        '`skill setup` is only available from local TUI/web sessions.',
      );
    }
    if (!skillName) {
      return context.badCommand('Usage', 'Usage: `skill setup <skill>`');
    }

    const { setupSkillDependencies } = await import(
      '../skills/skills-install.js'
    );
    const result = await setupSkillDependencies({ skillName });
    const lines = [result.message];
    if (result.stdout) {
      lines.push('', 'stdout:', result.stdout);
    }
    if (result.stderr) {
      lines.push('', 'stderr:', result.stderr);
    }
    return result.ok
      ? context.infoCommand('Skill Setup Complete', lines.join('\n'))
      : context.badCommand('Skill Setup Failed', lines.join('\n'));
  }

  if (sub === 'import') {
    const { source, force, skipSkillScan } = parseSkillImportArgs(
      context.args.slice(2),
      {
        commandPrefix: 'skill',
        commandName: 'import',
        allowForce: true,
      },
    );

    const { importSkill } = await import('../skills/skills-import.js');
    const result = await importSkill(source, {
      force,
      skipGuard: skipSkillScan,
    });
    const lines = [
      ...buildGuardWarningLines(result),
      `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
      `Installed to ${result.skillDir}`,
    ];
    return context.infoCommand('Skill Import', lines.join('\n'));
  }

  if (sub === 'sync') {
    const { source, skipSkillScan } = parseSkillImportArgs(
      context.args.slice(2),
      {
        commandPrefix: 'skill',
        commandName: 'sync',
        allowForce: false,
      },
    );

    const { importSkill } = await import('../skills/skills-import.js');
    const result = await importSkill(source, {
      force: true,
      skipGuard: skipSkillScan,
    });
    const lines = [
      ...buildGuardWarningLines(result),
      `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
      `Installed to ${result.skillDir}`,
    ];
    return context.infoCommand('Skill Sync', lines.join('\n'));
  }

  return context.badCommand('Usage', SKILL_COMMAND_USAGE);
}
