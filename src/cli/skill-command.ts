import readline from 'node:readline/promises';

import {
  getRuntimeConfig,
  getRuntimeSkillScopeDisabledNames,
  setRuntimeSkillScopeEnabled,
  updateRuntimeConfig,
} from '../config/runtime-config.js';
import {
  formatSkillAmendment,
  formatSkillHealthMetrics,
  formatSkillObservationRun,
} from '../skills/skill-formatters.js';
import { parseSkillImportArgs } from '../skills/skill-import-args.js';
import { buildGuardWarningLines } from '../skills/skill-import-warnings.js';
import { resolveSkillInstallMode } from '../skills/skill-install-mode.js';
import { normalizeArgs, parseSkillScopeArgs } from './common.js';
import { isHelpRequest, printSkillUsage } from './help.js';

function printFormattedBlock(block: string): void {
  for (const line of block.split('\n')) {
    console.log(line);
  }
}

export async function handleSkillCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printSkillUsage();
    return;
  }

  const sub = normalized[0].toLowerCase();
  if (sub === 'list') {
    const { listSkillCatalogEntries } = await import(
      '../skills/skills-management.js'
    );
    const catalog = listSkillCatalogEntries();
    let currentCategory = '';
    for (const skill of catalog) {
      if (skill.category !== currentCategory) {
        if (currentCategory) console.log('');
        currentCategory = skill.category;
        console.log(`${currentCategory}:`);
      }
      const availability = skill.available
        ? 'available'
        : skill.missing.join(', ');
      console.log(`  ${skill.name} [${availability}]`);
      for (const install of skill.installs) {
        const label = install.label ? ` — ${install.label}` : '';
        console.log(`    ${install.id} (${install.kind})${label}`);
      }
    }
    return;
  }

  if (sub === 'enable' || sub === 'disable') {
    const { channelKind, remaining } = parseSkillScopeArgs(normalized.slice(1));
    const skillName = remaining[0];
    if (!skillName || remaining.length !== 1) {
      printSkillUsage();
      throw new Error(
        `Expected exactly one skill name for \`hybridclaw skill ${sub}\`.`,
      );
    }

    const enabled = sub === 'enable';
    const { setSkillPackageEnabled } = await import(
      '../skills/skills-lifecycle.js'
    );
    setSkillPackageEnabled({ skillName, enabled, channelKind, actor: 'cli' });
    const nextConfig = getRuntimeConfig();
    console.log(
      `${enabled ? 'Enabled' : 'Disabled'} ${skillName} in ${channelKind ?? 'global'} scope.`,
    );
    if (
      channelKind &&
      enabled &&
      getRuntimeSkillScopeDisabledNames(nextConfig).has(skillName)
    ) {
      console.log(`${skillName} remains globally disabled.`);
    }
    return;
  }

  if (sub === 'toggle') {
    const { channelKind, remaining } = parseSkillScopeArgs(normalized.slice(1));
    if (remaining.length > 0) {
      printSkillUsage();
      throw new Error(
        'Unexpected positional arguments for `hybridclaw skill toggle`.',
      );
    }

    const { loadSkillCatalog } = await import('../skills/skills.js');
    const catalog = loadSkillCatalog();
    if (catalog.length === 0) {
      console.log('No skills found.');
      return;
    }
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error(
        '`hybridclaw skill toggle` requires an interactive terminal.',
      );
    }

    const currentConfig = getRuntimeConfig();
    const scopeDisabled = getRuntimeSkillScopeDisabledNames(
      currentConfig,
      channelKind,
    );
    const globalDisabled = getRuntimeSkillScopeDisabledNames(currentConfig);
    for (const [index, skill] of catalog.entries()) {
      const marker = scopeDisabled.has(skill.name) ? '[x]' : '[ ]';
      const globalSuffix =
        channelKind &&
        globalDisabled.has(skill.name) &&
        !scopeDisabled.has(skill.name)
          ? ' (globally disabled)'
          : '';
      console.log(
        `${index + 1}. ${marker} ${skill.name} (${skill.category})${globalSuffix}`,
      );
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      const answer = (
        await rl.question(
          `Toggle which skill number for ${channelKind ?? 'global'} scope? `,
        )
      ).trim();
      if (!answer) {
        console.log('No changes made.');
        return;
      }
      const selection = Number.parseInt(answer, 10);
      if (
        !Number.isInteger(selection) ||
        selection < 1 ||
        selection > catalog.length
      ) {
        throw new Error('Choose a listed skill number.');
      }
      const selected = catalog[selection - 1];
      if (!selected) {
        throw new Error('Choose a listed skill number.');
      }
      const enabled = scopeDisabled.has(selected.name);
      const nextConfig = updateRuntimeConfig((draft) => {
        setRuntimeSkillScopeEnabled(draft, selected.name, enabled, channelKind);
      });
      console.log(
        `${enabled ? 'Enabled' : 'Disabled'} ${selected.name} in ${channelKind ?? 'global'} scope.`,
      );
      if (
        channelKind &&
        enabled &&
        getRuntimeSkillScopeDisabledNames(nextConfig).has(selected.name)
      ) {
        console.log(`${selected.name} remains globally disabled.`);
      }
    } finally {
      rl.close();
    }
    return;
  }

  if (sub === 'inspect') {
    const { inspectObservedSkill, inspectObservedSkills } = await import(
      '../skills/skills-management.js'
    );
    const target = normalized[1];
    if (target === '--all') {
      const metricsList = inspectObservedSkills();
      if (metricsList.length === 0) {
        console.log(
          'No observed skills found in the current inspection window.',
        );
        return;
      }
      for (const [index, metrics] of metricsList.entries()) {
        if (index > 0) console.log('');
        printFormattedBlock(
          formatSkillHealthMetrics(metrics, { errorClusterLayout: 'expanded' }),
        );
      }
      return;
    }
    if (!target) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill inspect`.');
    }
    printFormattedBlock(
      formatSkillHealthMetrics(inspectObservedSkill(target), {
        errorClusterLayout: 'expanded',
      }),
    );
    return;
  }

  if (sub === 'learn') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill learn`.');
    }

    const { DEFAULT_AGENT_ID } = await import('../agents/agent-types.js');
    const { runSkillAmendmentCommand } = await import(
      '../skills/skills-management.js'
    );

    const action = normalized.includes('--apply')
      ? 'apply'
      : normalized.includes('--reject')
        ? 'reject'
        : normalized.includes('--rollback')
          ? 'rollback'
          : 'propose';

    const result = await runSkillAmendmentCommand({
      skillName,
      action,
      reviewedBy: 'cli',
      agentId: DEFAULT_AGENT_ID,
      rollbackReason: 'Rollback requested via CLI.',
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    if (result.action === 'applied') {
      console.log(
        `Applied staged amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    if (result.action === 'rejected') {
      console.log(
        `Rejected staged amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    if (result.action === 'rolled_back') {
      console.log(
        `Rolled back amendment v${result.amendment.version} for ${skillName}.`,
      );
      return;
    }
    console.log(
      `Staged amendment v${result.amendment.version} for ${skillName}.`,
    );
    console.log(
      `Guard: ${result.amendment.guard_verdict} (${result.amendment.guard_findings_count} finding(s))`,
    );
    console.log(`Diff: ${result.amendment.diff_summary}`);
    return;
  }

  if (sub === 'runs') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill runs`.');
    }
    const { getSkillExecutionRuns } = await import(
      '../skills/skills-management.js'
    );
    const runs = getSkillExecutionRuns(skillName);
    if (runs.length === 0) {
      console.log(`No observations found for ${skillName}.`);
      return;
    }
    for (const [index, observation] of runs.entries()) {
      if (index > 0) console.log('');
      printFormattedBlock(formatSkillObservationRun(observation));
    }
    return;
  }

  if (sub === 'history') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill history`.');
    }
    const { getSkillAmendmentHistory } = await import(
      '../skills/skills-management.js'
    );
    const history = getSkillAmendmentHistory(skillName);
    if (history.length === 0) {
      console.log(`No amendment history found for ${skillName}.`);
      return;
    }
    for (const [index, amendment] of history.entries()) {
      if (index > 0) console.log('');
      printFormattedBlock(
        formatSkillAmendment(amendment, { style: 'compact' }),
      );
    }
    return;
  }

  if (sub === 'install') {
    const installMode = resolveSkillInstallMode(normalized.slice(1), {
      commandPrefix: 'hybridclaw skill',
    });
    if (!installMode.ok) {
      printSkillUsage();
      if (installMode.error === 'missing-dependency') {
        throw new Error(
          'Usage: `hybridclaw skill install <skill-name> <dependency>`.',
        );
      }
      if (installMode.error === 'dependency-flags') {
        throw new Error(
          'Package install flags can only be used with `hybridclaw skill install <source>`.',
        );
      }
      throw new Error(
        'Usage: `hybridclaw skill install <source>` or `hybridclaw skill install <skill-name> <dependency>`.',
      );
    }
    if (installMode.mode === 'package') {
      const { installSkillPackage } = await import(
        '../skills/skills-lifecycle.js'
      );
      const result = await installSkillPackage(installMode.source, {
        actor: 'cli',
        force: installMode.force,
        skipGuard: installMode.skipSkillScan,
      });
      for (const warning of buildGuardWarningLines(result)) {
        console.warn(warning);
      }
      console.log(
        `${result.action === 'upgrade' ? 'Upgraded' : 'Installed'} ${result.manifest.name} v${result.manifest.version} from ${result.resolvedSource}`,
      );
      console.log(`Installed to ${result.skillDir}`);
      return;
    }

    const { installSkillDependency } = await import(
      '../skills/skills-install.js'
    );
    const result = await installSkillDependency({
      skillName: installMode.skillName,
      installId: installMode.installId,
    });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (!result.ok) {
      throw new Error(result.message);
    }
    console.log(result.message);
    return;
  }

  if (sub === 'upgrade') {
    const { source, skipSkillScan } = parseSkillImportArgs(
      normalized.slice(1),
      {
        commandPrefix: 'hybridclaw skill',
        commandName: 'upgrade',
        allowForce: false,
      },
    );
    const { upgradeSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    const result = await upgradeSkillPackage(source, {
      actor: 'cli',
      skipGuard: skipSkillScan,
    });
    for (const warning of buildGuardWarningLines(result)) {
      console.warn(warning);
    }
    console.log(
      `Upgraded ${result.manifest.name} v${result.manifest.version} from ${result.resolvedSource}`,
    );
    console.log(`Installed to ${result.skillDir}`);
    return;
  }

  if (sub === 'uninstall') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Usage: `hybridclaw skill uninstall <skill-name>`.');
    }
    const { uninstallSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    try {
      const result = uninstallSkillPackage(skillName, { actor: 'cli' });
      console.log(`Uninstalled ${result.skillName} from ${result.skillDir}`);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to uninstall skill.';
      throw new Error(`Failed to uninstall ${skillName}: ${message}`);
    }
    return;
  }

  if (sub === 'revisions') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Usage: `hybridclaw skill revisions <skill-name>`.');
    }
    const { listSkillPackageRevisions } = await import(
      '../skills/skills-lifecycle.js'
    );
    let revisions: ReturnType<typeof listSkillPackageRevisions>;
    try {
      revisions = listSkillPackageRevisions(skillName);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : `Unknown skill ${skillName}.`;
      throw new Error(`Failed to list revisions for ${skillName}: ${message}`);
    }
    if (revisions.length === 0) {
      console.log(`No package revisions found for ${skillName}.`);
      return;
    }
    for (const revision of revisions) {
      console.log(
        `${revision.id} ${revision.createdAt} ${revision.md5} ${revision.byteLength} bytes route=${revision.route}`,
      );
    }
    return;
  }

  if (sub === 'rollback') {
    const skillName = normalized[1];
    const revisionId = Number.parseInt(normalized[2] || '', 10);
    if (!skillName || !Number.isInteger(revisionId)) {
      printSkillUsage();
      throw new Error(
        'Usage: `hybridclaw skill rollback <skill-name> <revision-id>`.',
      );
    }
    const { rollbackSkillPackage } = await import(
      '../skills/skills-lifecycle.js'
    );
    try {
      const result = rollbackSkillPackage({
        skillName,
        revisionId,
        actor: 'cli',
      });
      console.log(
        `Rolled back ${result.skillName} to revision ${result.revisionId}.`,
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown rollback error.';
      throw new Error(
        `Failed to roll back skill "${skillName}" to revision ${revisionId}: ${message}`,
      );
    }
    return;
  }

  if (sub === 'setup') {
    const skillName = normalized[1];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Usage: `hybridclaw skill setup <skill-name>`.');
    }

    const { setupSkillDependencies } = await import(
      '../skills/skills-install.js'
    );
    const result = await setupSkillDependencies({ skillName });
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (!result.ok) {
      throw new Error(result.message);
    }
    console.log(result.message);
    return;
  }

  if (sub === 'import') {
    const { source, force, skipSkillScan } = parseSkillImportArgs(
      normalized.slice(1),
      {
        commandPrefix: 'hybridclaw skill',
        commandName: 'import',
        allowForce: true,
      },
    );

    const { importSkill } = await import('../skills/skills-import.js');
    const result = await importSkill(source, {
      force,
      skipGuard: skipSkillScan,
    });
    for (const warning of buildGuardWarningLines(result)) {
      console.warn(warning);
    }
    console.log(
      `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
    );
    console.log(`Installed to ${result.skillDir}`);
    return;
  }

  if (sub === 'sync') {
    const { source, skipSkillScan } = parseSkillImportArgs(
      normalized.slice(1),
      {
        commandPrefix: 'hybridclaw skill',
        commandName: 'sync',
        allowForce: false,
      },
    );

    const { importSkill } = await import('../skills/skills-import.js');
    const result = await importSkill(source, {
      force: true,
      skipGuard: skipSkillScan,
    });
    for (const warning of buildGuardWarningLines(result)) {
      console.warn(warning);
    }
    console.log(
      `${result.replacedExisting ? 'Replaced' : 'Imported'} ${result.skillName} from ${result.resolvedSource}`,
    );
    console.log(`Installed to ${result.skillDir}`);
    return;
  }

  throw new Error(`Unknown skill subcommand: ${sub}`);
}
