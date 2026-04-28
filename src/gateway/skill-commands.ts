import type { SkillConfigChannelKind } from '../channels/channel.js';
import { SKILL_CONFIG_CHANNEL_KINDS } from '../channels/channel.js';
import { normalizeSkillConfigChannelKind } from '../channels/channel-registry.js';
import { normalizeArg, parseIdArg, parseLowerArg } from '../command-parsing.js';
import {
  getRuntimeConfig,
  getRuntimeSkillScopeDisabledNames,
} from '../config/runtime-config.js';
import {
  formatSkillAmendment,
  formatSkillHealthMetrics,
  formatSkillObservationRun,
} from '../skills/skill-formatters.js';
import { parseSkillImportArgs } from '../skills/skill-import-args.js';
import { buildGuardWarningLines } from '../skills/skill-import-warnings.js';
import { resolveSkillInstallMode } from '../skills/skill-install-mode.js';
import type { GatewayCommandResult } from './gateway-types.js';

const SKILL_COMMAND_USAGE =
  'Usage: `skill list|enable <name> [--channel <kind>]|disable <name> [--channel <kind>]|inspect <name>|inspect --all|runs <name>|install <source>|install <skill> <dependency>|upgrade <source>|uninstall <name>|revisions <name>|rollback <name> <revision-id>|setup <skill>|learn <name> [--apply|--reject|--rollback]|history <name>|sync [--skip-skill-scan] <source>|import [--force] [--skip-skill-scan] <source>`';
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

function hasExternalSkillSourceLabel(source: string): boolean {
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

export async function handleSkillCommand(
  context: SkillCommandContext,
): Promise<GatewayCommandResult> {
  const sub = parseLowerArg(context.args, 1);
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
    let hasExternalSourceLabels = false;
    let currentCategory = '';
    for (const skill of catalog) {
      const category = formatSkillCategoryLabel(skill.category);
      if (category !== currentCategory) {
        if (currentCategory) lines.push('');
        currentCategory = category;
        lines.push(`${category}:`);
      }
      const externalSourceMarker = hasExternalSkillSourceLabel(skill.source)
        ? '*'
        : '';
      if (externalSourceMarker) hasExternalSourceLabels = true;
      const availability = skill.available
        ? skill.enabled
          ? 'available'
          : 'disabled'
        : skill.missing.join(', ');
      const prefix = `  ${skill.name}${externalSourceMarker} [${availability}]`;
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
    if (hasExternalSourceLabels) {
      lines.push('', '* external source label, not verified provenance');
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
      const arg = normalizeArg(rest[i], { trim: true });
      if (arg === '--channel') {
        const next = normalizeArg(rest[i + 1], { trim: true });
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

    const enabled = sub === 'enable';
    const { setSkillPackageEnabled } = await import(
      '../skills/skills-lifecycle.js'
    );
    try {
      setSkillPackageEnabled({
        skillName,
        enabled,
        channelKind,
        actor: 'gateway-command',
      });
    } catch (err) {
      return context.badCommand(
        'Skill Enable/Disable Failed',
        err instanceof Error ? err.message : String(err),
      );
    }
    const nextConfig = getRuntimeConfig();
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
    const target = parseIdArg(context.args, 2);
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
        metricsList
          .map((metrics) => formatSkillHealthMetrics(metrics))
          .join('\n\n'),
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
    const skillName = parseIdArg(context.args, 2);
    if (!skillName) {
      return context.badCommand(
        'Usage',
        'Usage: `skill learn <name> [--apply|--reject|--rollback]`',
      );
    }

    const actions = new Set(
      context.args
        .slice(3)
        .map((entry) => normalizeArg(entry, { trim: true, lower: true }))
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
    const skillName = parseIdArg(context.args, 2);
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
      history.map((amendment) => formatSkillAmendment(amendment)).join('\n\n'),
    );
  }

  if (sub === 'runs') {
    const skillName = parseIdArg(context.args, 2);
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
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Install Restricted',
        '`skill install` is only available from local TUI/web sessions.',
      );
    }
    const installMode = resolveSkillInstallMode(context.args.slice(2), {
      commandPrefix: 'skill',
    });
    if (!installMode.ok) {
      if (installMode.error === 'missing-dependency') {
        return context.badCommand(
          'Usage',
          'Usage: `skill install <skill> <dependency>`',
        );
      }
      if (installMode.error === 'dependency-flags') {
        return context.badCommand(
          'Usage',
          'Package install flags can only be used with `skill install <source>`.',
        );
      }
      return context.badCommand(
        'Usage',
        'Usage: `skill install <source>` or `skill install <skill> <dependency>`',
      );
    }
    if (installMode.mode === 'package') {
      const { installSkillPackage } = await import(
        '../skills/skills-lifecycle.js'
      );
      const result = await installSkillPackage(installMode.source, {
        actor: 'gateway-command',
        force: installMode.force,
        skipGuard: installMode.skipSkillScan,
      });
      const lines = [
        ...buildGuardWarningLines(result),
        `${result.action === 'upgrade' ? 'Upgraded' : 'Installed'} ${result.manifest.name} v${result.manifest.version} from ${result.resolvedSource}`,
        `Installed to ${result.skillDir}`,
      ];
      return context.infoCommand('Skill Package Installed', lines.join('\n'));
    }

    const { installSkillDependency } = await import(
      '../skills/skills-install.js'
    );
    const result = await installSkillDependency({
      skillName: installMode.skillName,
      installId: installMode.installId,
    });
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
    const skillName = parseIdArg(context.args, 2);
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

  if (sub === 'upgrade') {
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Upgrade Restricted',
        '`skill upgrade` is only available from local TUI/web sessions.',
      );
    }
    const { source, skipSkillScan } = parseSkillImportArgs(
      context.args.slice(2),
      {
        commandPrefix: 'skill',
        commandName: 'upgrade',
        allowForce: false,
      },
    );

    const { upgradeSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    const result = await upgradeSkillPackage(source, {
      actor: 'gateway-command',
      skipGuard: skipSkillScan,
    });
    const lines = [
      ...buildGuardWarningLines(result),
      `Upgraded ${result.manifest.name} v${result.manifest.version} from ${result.resolvedSource}`,
      `Installed to ${result.skillDir}`,
    ];
    return context.infoCommand('Skill Package Upgraded', lines.join('\n'));
  }

  if (sub === 'uninstall') {
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Uninstall Restricted',
        '`skill uninstall` is only available from local TUI/web sessions.',
      );
    }
    const skillName = parseIdArg(context.args, 2);
    if (!skillName) {
      return context.badCommand('Usage', 'Usage: `skill uninstall <name>`');
    }
    const { uninstallSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    try {
      const result = uninstallSkillPackage(skillName, {
        actor: 'gateway-command',
      });
      return context.infoCommand(
        'Skill Package Uninstalled',
        `Uninstalled ${result.skillName} from ${result.skillDir}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return context.badCommand(
        'Skill Uninstall Failed',
        `Unable to uninstall \`${skillName}\`: ${message}`,
      );
    }
  }

  if (sub === 'revisions') {
    const skillName = parseIdArg(context.args, 2);
    if (!skillName) {
      return context.badCommand('Usage', 'Usage: `skill revisions <name>`');
    }
    const { listSkillPackageRevisions } = await import(
      '../skills/skills-lifecycle.js'
    );
    let revisions: ReturnType<typeof listSkillPackageRevisions>;
    try {
      revisions = listSkillPackageRevisions(skillName);
    } catch (error) {
      return context.badCommand(
        'Unknown Skill',
        error instanceof Error
          ? error.message
          : `Unknown skill \`${skillName}\`.`,
      );
    }
    if (revisions.length === 0) {
      return context.plainCommand(
        `No package revisions found for \`${skillName}\`.`,
      );
    }
    return context.infoCommand(
      `Skill Revisions (${skillName})`,
      revisions
        .map(
          (revision) =>
            `${revision.id} ${revision.createdAt} ${revision.md5} ${revision.byteLength} bytes route=${revision.route}`,
        )
        .join('\n'),
    );
  }

  if (sub === 'rollback') {
    if (!isLocalSession(context)) {
      return context.badCommand(
        'Skill Rollback Restricted',
        '`skill rollback` is only available from local TUI/web sessions.',
      );
    }
    const skillName = parseIdArg(context.args, 2);
    const revisionId = Number.parseInt(parseIdArg(context.args, 3) || '', 10);
    if (!skillName || !Number.isInteger(revisionId)) {
      return context.badCommand(
        'Usage',
        'Usage: `skill rollback <name> <revision-id>`',
      );
    }
    const { rollbackSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    try {
      const result = rollbackSkillPackage({
        skillName,
        revisionId,
        actor: 'gateway-command',
      });
      return context.infoCommand(
        'Skill Package Rolled Back',
        `Rolled back ${result.skillName} to revision ${result.revisionId}.`,
      );
    } catch (error) {
      const message =
        error instanceof Error
          ? error.message
          : 'Invalid skill name or revision id.';
      return context.badCommand('Skill Rollback Failed', message);
    }
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
