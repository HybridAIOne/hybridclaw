import {
  type OutputVerbosity,
  parseOutputVerbosity,
  stripVerbosityFlags,
} from '../cli/verbosity.js';
import type { ConfidentialFinding } from '../security/confidential-redact.js';
import { loadConfidentialRules } from '../security/confidential-rules.js';
import {
  applyLeakReportFilter,
  type LeakScanReport,
  type PromptCategory,
  SEVERITY_LEVELS,
  scanAllAuditSessionsForLeaks,
  scanAuditSessionForLeaks,
  summarizeLeakReports,
} from './leak-scanner.js';

const VALID_CATEGORIES: ReadonlySet<PromptCategory> = new Set([
  'in',
  'out',
  'tool',
  'url',
]);

interface ParsedScanFlags {
  remaining: string[];
  level: ConfidentialFinding['sensitivity'] | null;
  categories: Set<PromptCategory> | null;
  error: string | null;
}

function parseValueFlag(
  args: string[],
  index: number,
  name: string,
): { value: string | null; consumed: number } {
  const arg = args[index];
  const eqIdx = arg.indexOf('=');
  if (eqIdx >= 0) {
    return { value: arg.slice(eqIdx + 1), consumed: 1 };
  }
  if (arg === name) {
    const next = args[index + 1];
    if (next == null || next.startsWith('--')) {
      return { value: null, consumed: 1 };
    }
    return { value: next, consumed: 2 };
  }
  return { value: null, consumed: 0 };
}

function parseScanFlags(args: string[]): ParsedScanFlags {
  let level: ConfidentialFinding['sensitivity'] | null = null;
  let categories: Set<PromptCategory> | null = null;
  const remaining: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--level' || arg.startsWith('--level=')) {
      const { value, consumed } = parseValueFlag(args, i, '--level');
      if (!value) {
        return {
          remaining,
          level,
          categories,
          error: '--level requires a value (critical, high, medium, low)',
        };
      }
      const normalized = value.trim().toLowerCase();
      if (
        !SEVERITY_LEVELS.includes(
          normalized as ConfidentialFinding['sensitivity'],
        )
      ) {
        return {
          remaining,
          level,
          categories,
          error: `--level must be one of ${SEVERITY_LEVELS.join(', ')} (got "${value}")`,
        };
      }
      level = normalized as ConfidentialFinding['sensitivity'];
      i += consumed;
      continue;
    }
    if (arg === '--type' || arg.startsWith('--type=')) {
      const { value, consumed } = parseValueFlag(args, i, '--type');
      if (!value) {
        return {
          remaining,
          level,
          categories,
          error: '--type requires a value (in,out,tool,url)',
        };
      }
      const next = new Set<PromptCategory>();
      for (const raw of value.split(',')) {
        const normalized = raw.trim().toLowerCase();
        if (!normalized) continue;
        if (!VALID_CATEGORIES.has(normalized as PromptCategory)) {
          return {
            remaining,
            level,
            categories,
            error: `--type values must be one of in, out, tool, url (got "${raw}")`,
          };
        }
        next.add(normalized as PromptCategory);
      }
      if (next.size === 0) {
        return {
          remaining,
          level,
          categories,
          error: '--type requires at least one category',
        };
      }
      categories = next;
      i += consumed;
      continue;
    }
    remaining.push(arg);
    i += 1;
  }
  return { remaining, level, categories, error: null };
}

const ANSI_RED = '\x1b[31m';
const ANSI_YELLOW = '\x1b[33m';
const ANSI_GREEN = '\x1b[32m';
const ANSI_BOLD = '\x1b[1m';
const ANSI_RESET = '\x1b[0m';

function color(text: string, code: string): string {
  return process.stdout.isTTY ? `${code}${text}${ANSI_RESET}` : text;
}

function severityColor(severity: LeakScanReport['severity']): string {
  if (severity === 'critical' || severity === 'high') return ANSI_RED;
  if (severity === 'medium') return ANSI_YELLOW;
  return ANSI_GREEN;
}

function highlightExcerpt(excerpt: string): string {
  if (!process.stdout.isTTY) return excerpt;
  // The scanner wraps each match in »…« — swap those for ANSI bold red so
  // the matched span pops in a terminal but the raw text still reads.
  return excerpt.replace(
    /»([^«]+)«/g,
    `${ANSI_BOLD}${ANSI_RED}$1${ANSI_RESET}`,
  );
}

/**
 * Format an ISO timestamp as `YYYY-MM-DD HH:MM:SS` (drop millis + `Z`).
 * Seconds are precise enough for human review and the result lines up in
 * fixed-width columns.
 */
function formatTimestamp(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const CATEGORY_LABEL: Record<PromptCategory, string> = {
  in: 'in   (→ LLM)',
  out: 'out  (← LLM)',
  tool: 'tool (I/O)',
  url: 'url  (URLs)',
};

function summarizeReport(report: LeakScanReport): string {
  const tag = color(
    report.severity.toUpperCase().padEnd(8),
    severityColor(report.severity),
  );
  const skipped =
    report.recordsSkippedByType > 0
      ? ` skipped=${report.recordsSkippedByType}`
      : '';
  return `${tag} session=${report.sessionId} score=${report.score}/100 matches=${report.totalMatches} records=${report.matchedRecords.length}/${report.recordsScanned}${skipped}`;
}

function printReportDetail(report: LeakScanReport): void {
  if (report.errors.length > 0) {
    for (const error of report.errors) {
      console.log(`  ! ${error}`);
    }
  }
  if (report.matchedRecords.length === 0) {
    if (report.recordsScanned === 0) {
      console.log('  (no prompt-bearing audit records found)');
    } else {
      console.log('  (no confidential matches)');
    }
    return;
  }

  for (const record of report.matchedRecords) {
    const sevTag = color(
      record.severity.toUpperCase(),
      severityColor(record.severity),
    );
    const placeholder = record.hadPlaceholder ? ' (post-dehydrate)' : '';
    // Direction is redundant on the record header — the event type
    // (`tool.result`, `turn.start`, …) already implies it. The summary
    // footer aggregates by direction where the rollup actually helps.
    console.log(
      `  #${record.seq} ${formatTimestamp(record.timestamp)} ${record.eventType} ${sevTag} score=${record.score}${placeholder}`,
    );
    for (const finding of record.findings) {
      // Severity is shown on the record header above. Match text is shown
      // verbatim in the excerpt wrapped in »…« (and ANSI-bold-red on TTY),
      // so an explicit `match="..."` would just repeat it.
      const sevHint =
        finding.sensitivity !== record.severity
          ? `[${finding.sensitivity}] `
          : '';
      console.log(
        `    - ${sevHint}${finding.kind}:${finding.label} ×${finding.matches}  ${highlightExcerpt(finding.excerpt)}`,
      );
    }
  }
}

const SUMMARY_RULE = '*'.repeat(60);

function printBanner(title: string): void {
  console.log(SUMMARY_RULE);
  const inner = title.toUpperCase();
  const padded = inner.padStart((54 + inner.length) / 2).padEnd(54);
  console.log(`***${padded}***`);
  console.log(SUMMARY_RULE);
}

function printRunHeader(
  rulesLoaded: number,
  rulesPath: string | null,
  scope: string,
  filters: string | null,
): void {
  printBanner('Audit Leak Scanner');
  console.log(`Rules: ${rulesLoaded} from ${rulesPath ?? 'embedded'}`);
  console.log(`Scope: ${scope}`);
  if (filters) console.log(`Filter: ${filters}`);
}

function pluralize(value: number, singular: string, plural: string): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function printSummaryFooter(reports: LeakScanReport[]): void {
  const summary = summarizeLeakReports(reports);
  const sevOrder: ConfidentialFinding['sensitivity'][] = [
    'critical',
    'high',
    'medium',
    'low',
  ];
  const catOrder: PromptCategory[] = ['in', 'out', 'tool', 'url'];
  // No second banner — the AUDIT LEAK SCANNER block at the top already
  // brackets the report. Keep blocks visually separated by single blank
  // lines and close with one rule for copy-paste delimiting.
  console.log('');
  console.log(
    `${summary.affectedSessions}/${summary.totalSessions} ${summary.totalSessions === 1 ? 'session' : 'sessions'} affected, ${pluralize(summary.totalMatches, 'match', 'matches')} total`,
  );
  console.log('');
  console.log('By session severity:');
  for (const severity of sevOrder) {
    const count = summary.bySeverity[severity];
    const label = color(
      severity.toUpperCase().padEnd(8),
      severityColor(severity),
    );
    console.log(`  ${label} ${pluralize(count, 'session', 'sessions')}`);
  }
  console.log('');
  console.log('By type:');
  for (const cat of catOrder) {
    const totals = summary.byCategory[cat];
    const label = CATEGORY_LABEL[cat].padEnd(13);
    console.log(
      `  ${label} ${pluralize(totals.matches, 'match', 'matches')} in ${pluralize(totals.records, 'record', 'records')} in ${pluralize(totals.sessions, 'session', 'sessions')}`,
    );
  }
  console.log(SUMMARY_RULE);
}

export async function runLeakScanCli(args: string[]): Promise<void> {
  const useJson = args.includes('--json');
  const verbosity: OutputVerbosity = parseOutputVerbosity(args);
  const afterVerbosity = stripVerbosityFlags(args);
  const flags = parseScanFlags(afterVerbosity);
  if (flags.error) {
    console.error(flags.error);
    process.exitCode = 1;
    return;
  }
  const positional = flags.remaining.filter((arg) => !arg.startsWith('--'));
  const sessionId = positional[0];
  // Asking for one specific session implies "show me everything about it",
  // including clean and the per-session detail block.
  const effectiveVerbosity: OutputVerbosity =
    sessionId && verbosity === 'standard' ? 'all' : verbosity;

  const ruleSet = loadConfidentialRules();
  if (ruleSet.rules.length === 0) {
    const message =
      ruleSet.sourcePath != null
        ? `No usable rules found in ${ruleSet.sourcePath}.`
        : 'No .confidential.yml found. Create ./.confidential.yml (project-local) or ~/.hybridclaw/.confidential.yml (user-global) to enable leak scanning.';
    if (useJson) {
      console.log(JSON.stringify({ ok: false, reason: message }, null, 2));
    } else {
      console.log(message);
    }
    process.exitCode = 1;
    return;
  }

  const rawReports = sessionId
    ? [scanAuditSessionForLeaks(sessionId, ruleSet)]
    : scanAllAuditSessionsForLeaks(ruleSet);
  const reports =
    flags.level || flags.categories
      ? applyLeakReportFilter(rawReports, {
          minSeverity: flags.level ?? undefined,
          categories: flags.categories ?? undefined,
        })
      : rawReports;

  if (useJson) {
    const serialized = reports.map((report) => ({
      sessionId: report.sessionId,
      filePath: report.filePath,
      recordsScanned: report.recordsScanned,
      recordsSkippedByType: report.recordsSkippedByType,
      matchedRecords: report.matchedRecords,
      totalMatches: report.totalMatches,
      score: report.score,
      rawScore: report.rawScore,
      severity: report.severity,
      errors: report.errors,
    }));
    console.log(
      JSON.stringify(
        {
          rulesLoaded: ruleSet.rules.length,
          summary: summarizeLeakReports(reports),
          reports: serialized,
        },
        null,
        2,
      ),
    );
    if (reports.some((report) => report.totalMatches > 0)) {
      process.exitCode = 2;
    }
    return;
  }

  const filterParts: string[] = [];
  if (flags.level) filterParts.push(`level≥${flags.level}`);
  if (flags.categories) {
    filterParts.push(`type=${[...flags.categories].sort().join(',')}`);
  }
  printRunHeader(
    ruleSet.rules.length,
    ruleSet.sourcePath,
    sessionId
      ? `session ${sessionId}`
      : `${reports.length} session${reports.length === 1 ? '' : 's'}`,
    filterParts.length > 0 ? filterParts.join('  ') : null,
  );

  if (reports.length === 0) {
    console.log('No audit sessions found.');
    return;
  }

  const leaksFound = reports.some((report) => report.totalMatches > 0);

  if (effectiveVerbosity !== 'quiet') {
    console.log('');
    let cleanHidden = 0;
    for (const report of reports) {
      // `standard` suppresses sessions with zero matches — most workspaces
      // have many short clean sessions and the noise drowns the signal.
      // `all` restores them.
      if (
        effectiveVerbosity === 'standard' &&
        report.totalMatches === 0 &&
        report.errors.length === 0
      ) {
        cleanHidden += 1;
        continue;
      }
      console.log(summarizeReport(report));
      printReportDetail(report);
    }

    if (cleanHidden > 0) {
      console.log(
        `(${cleanHidden} clean session${cleanHidden === 1 ? '' : 's'} hidden — pass --all to show)`,
      );
    }
  }

  printSummaryFooter(reports);

  if (leaksFound) {
    process.exitCode = 2;
  }
}
