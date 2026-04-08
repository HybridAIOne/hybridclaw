import readline from 'node:readline/promises';

import {
  getRuntimeConfig,
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
import { normalizeArgs, parseSkillScopeArgs } from './common.js';
import { isHelpRequest, printSkillUsage } from './help.js';

function printSkillMetrics(metrics: SkillHealthMetrics): void {
  const formatRatioAsPercent = (value: number): string =>
    `${(value * 100).toFixed(2)}%`;
  console.log(`Skill: ${metrics.skill_name}`);
  console.log(`Executions: ${metrics.total_executions}`);
  console.log(`Success rate: ${formatRatioAsPercent(metrics.success_rate)}`);
  console.log(`Avg duration: ${Math.round(metrics.avg_duration_ms)}ms`);
  console.log(
    `Tool breakage: ${formatRatioAsPercent(metrics.tool_breakage_rate)}`,
  );
  console.log(`Positive feedback: ${metrics.positive_feedback_count}`);
  console.log(`Negative feedback: ${metrics.negative_feedback_count}`);
  console.log(`Degraded: ${metrics.degraded ? 'yes' : 'no'}`);
  if (metrics.degradation_reasons.length > 0) {
    console.log(`Reasons: ${metrics.degradation_reasons.join('; ')}`);
  }
  if (metrics.error_clusters.length > 0) {
    console.log('Error clusters:');
    for (const cluster of metrics.error_clusters) {
      const sample = cluster.sample_detail ? ` — ${cluster.sample_detail}` : '';
      console.log(`  ${cluster.category}: ${cluster.count}${sample}`);
    }
  }
}

function printAmendmentSummary(amendment: SkillAmendment): void {
  console.log(
    `v${amendment.version} [${amendment.status}] guard=${amendment.guard_verdict}/${amendment.guard_findings_count} runs=${amendment.runs_since_apply}`,
  );
  console.log(`  created: ${amendment.created_at}`);
  if (amendment.reviewed_by) {
    console.log(`  reviewed by: ${amendment.reviewed_by}`);
  }
  if (amendment.rationale) {
    console.log(`  rationale: ${amendment.rationale}`);
  }
  if (amendment.diff_summary) {
    console.log(`  diff: ${amendment.diff_summary}`);
  }
}

function printSkillObservationRun(observation: SkillObservation): void {
  console.log(`Run: ${observation.run_id}`);
  console.log(`Outcome: ${observation.outcome}`);
  console.log(`Observed: ${observation.created_at}`);
  console.log(`Duration: ${observation.duration_ms}ms`);
  console.log(
    `Tools: ${observation.tool_calls_failed}/${observation.tool_calls_attempted} failed`,
  );
  if (observation.feedback_sentiment) {
    console.log(`Feedback: ${observation.feedback_sentiment}`);
  }
  if (observation.user_feedback) {
    console.log(`Feedback note: ${observation.user_feedback}`);
  }
  if (observation.error_category) {
    console.log(`Error category: ${observation.error_category}`);
  }
  if (observation.error_detail) {
    console.log(`Error detail: ${observation.error_detail}`);
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

    const { loadSkillCatalog } = await import('../skills/skills.js');
    const known = loadSkillCatalog().some((skill) => skill.name === skillName);
    if (!known) {
      throw new Error(`Unknown skill: ${skillName}`);
    }

    const enabled = sub === 'enable';
    const nextConfig = updateRuntimeConfig((draft) => {
      setRuntimeSkillScopeEnabled(draft, skillName, enabled, channelKind);
    });
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
        printSkillMetrics(metrics);
      }
      return;
    }
    if (!target) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill inspect`.');
    }
    printSkillMetrics(inspectObservedSkill(target));
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
      printSkillObservationRun(observation);
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
      printAmendmentSummary(amendment);
    }
    return;
  }

  if (sub === 'install') {
    const skillName = normalized[1];
    const installId = normalized[2];
    if (!skillName) {
      printSkillUsage();
      throw new Error('Missing skill name for `hybridclaw skill install`.');
    }

    const { installSkillDependency } = await import(
      '../skills/skills-install.js'
    );
    const result = await installSkillDependency({ skillName, installId });
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
