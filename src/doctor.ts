import readline from 'node:readline/promises';
import { doctorChecks } from './doctor/checks/index.js';
import type {
  DiagResult,
  DoctorArgs,
  DoctorFixOutcome,
  DoctorReport,
} from './doctor/types.js';
import {
  normalizeComponent,
  normalizeDoctorComponentList,
  runChecks,
  summarizeCounts,
  toErrorMessage,
} from './doctor/utils.js';

export type {
  DiagFix,
  DiagResult,
  DoctorArgs,
  DoctorCategory,
  DoctorFixOutcome,
  DoctorReport,
} from './doctor/types.js';

function parseDoctorArgs(args: string[]): DoctorArgs {
  let component: DoctorArgs['component'] = null;
  let fix = false;
  let json = false;

  for (const rawArg of args) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg === '--fix') {
      fix = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`Unknown doctor option: ${arg}`);
    }

    const normalized = normalizeComponent(arg);
    if (!normalized) {
      throw new Error(
        `Unknown doctor component: ${arg}. Expected one of ${normalizeDoctorComponentList()}.`,
      );
    }
    if (component) {
      throw new Error('Doctor accepts at most one component filter.');
    }
    component = normalized;
  }

  return { component, fix, json };
}

function shouldPromptForFixes(args: DoctorArgs): boolean {
  return (
    args.fix &&
    !args.json &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY)
  );
}

async function confirmFix(
  rl: readline.Interface,
  result: DiagResult,
): Promise<boolean> {
  const requiresApprovalSuffix = result.fix?.requiresApproval
    ? ' (approval required)'
    : '';
  const prompt = result.fix?.summary
    ? `Apply fix for ${result.label}${requiresApprovalSuffix}? ${result.fix.summary} [y/N] `
    : `Apply fix for ${result.label}${requiresApprovalSuffix}? [y/N] `;
  const answer = (await rl.question(prompt)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

async function applyFixes(
  args: DoctorArgs,
  results: DiagResult[],
): Promise<DoctorFixOutcome[]> {
  const outcomes: DoctorFixOutcome[] = [];
  const applied: Array<{
    category: DiagResult['category'];
    label: string;
    rollback?: () => Promise<void>;
  }> = [];

  const promptForFixes = shouldPromptForFixes(args);
  const rl = promptForFixes
    ? readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      })
    : null;

  try {
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (!result.fix || result.severity === 'ok') continue;

      if (!rl && result.fix.requiresApproval) {
        outcomes.push({
          category: result.category,
          label: result.label,
          status: 'skipped',
          message: 'Skipped because interactive approval is required',
        });
        continue;
      }

      if (rl && !(await confirmFix(rl, result))) {
        outcomes.push({
          category: result.category,
          label: result.label,
          status: 'skipped',
          message: 'Skipped by user',
        });
        continue;
      }

      try {
        await result.fix.apply();
        outcomes.push({
          category: result.category,
          label: result.label,
          status: 'applied',
          message:
            result.fix.summary ||
            `Applied fix for ${result.label.toLowerCase()}`,
        });
        applied.push({
          category: result.category,
          label: result.label,
          rollback: result.fix.rollback,
        });
      } catch (error) {
        outcomes.push({
          category: result.category,
          label: result.label,
          status: 'failed',
          message: toErrorMessage(error),
        });

        for (
          let rollbackIndex = applied.length - 1;
          rollbackIndex >= 0;
          rollbackIndex -= 1
        ) {
          const appliedFix = applied[rollbackIndex];
          if (!appliedFix.rollback) continue;
          try {
            await appliedFix.rollback();
            outcomes.push({
              category: appliedFix.category,
              label: appliedFix.label,
              status: 'rolled_back',
              message: 'Rolled back after a later fix failed',
            });
          } catch (rollbackError) {
            outcomes.push({
              category: appliedFix.category,
              label: appliedFix.label,
              status: 'rollback_failed',
              message: toErrorMessage(rollbackError),
            });
          }
        }

        for (
          let remaining = index + 1;
          remaining < results.length;
          remaining += 1
        ) {
          const pending = results[remaining];
          if (!pending.fix || pending.severity === 'ok') continue;
          outcomes.push({
            category: pending.category,
            label: pending.label,
            status: 'skipped',
            message: 'Skipped after previous fix failure',
          });
        }
        break;
      }
    }
  } finally {
    rl?.close();
  }

  return outcomes;
}

export async function runDoctor(args: DoctorArgs): Promise<DoctorReport> {
  const checks = doctorChecks().filter((check) =>
    args.component ? check.category === args.component : true,
  );

  let results = await runChecks(checks);
  const fixes = args.fix ? await applyFixes(args, results) : [];

  if (args.fix && fixes.some((fix) => fix.status === 'applied')) {
    results = await runChecks(checks);
  }

  return {
    generatedAt: new Date().toISOString(),
    component: args.component,
    results: results.map((result) => ({
      ...result,
      fixable: Boolean(result.fix),
      fix: undefined,
    })) as Array<DiagResult & { fixable: boolean }>,
    summary: summarizeCounts(results),
    fixes,
  };
}

type RenderedFixStatus = Extract<
  DoctorFixOutcome['status'],
  'applied' | 'failed' | 'skipped'
>;

function isRenderedFixStatus(
  status: DoctorFixOutcome['status'],
): status is RenderedFixStatus {
  return status === 'applied' || status === 'failed' || status === 'skipped';
}

function fixSymbol(status: RenderedFixStatus): string {
  if (status === 'applied') return '✓';
  if (status === 'failed') return '✖';
  return '⚠';
}

export function renderDoctorReport(report: DoctorReport): string {
  const lines = ['HybridClaw Doctor', ''];
  const labelWidth = report.results.reduce(
    (max, result) => Math.max(max, result.label.length),
    0,
  );

  for (const result of report.results) {
    const symbol =
      result.severity === 'ok' ? '✓' : result.severity === 'warn' ? '⚠' : '✖';
    lines.push(
      `${symbol} ${result.label.padEnd(labelWidth)}  ${result.message}`,
    );
  }

  const renderedFixes = report.fixes.filter(
    (
      fix,
    ): fix is DoctorFixOutcome & {
      status: RenderedFixStatus;
    } => isRenderedFixStatus(fix.status),
  );

  if (renderedFixes.length > 0) {
    lines.push('');
    for (const fix of renderedFixes) {
      lines.push(
        `${fixSymbol(fix.status)} Fix ${fix.label.padEnd(labelWidth)}  ${fix.message}`,
      );
    }
  }

  lines.push('');
  lines.push(
    `${report.summary.ok} ok · ${report.summary.warn} warning${report.summary.warn === 1 ? '' : 's'} · ${report.summary.error} error${report.summary.error === 1 ? '' : 's'}`,
  );
  return lines.join('\n');
}

export async function runDoctorCli(argv: string[]): Promise<number> {
  try {
    const args = parseDoctorArgs(argv);
    const report = await runDoctor(args);
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(renderDoctorReport(report));
    }
    return report.summary.exitCode;
  } catch (error) {
    console.error(toErrorMessage(error));
    return 1;
  }
}
