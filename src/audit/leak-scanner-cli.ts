import {
  type OutputVerbosity,
  parseOutputVerbosity,
  stripVerbosityFlags,
} from '../cli/verbosity.js';
import type { ConfidentialFinding } from '../security/confidential-redact.js';
import { loadConfidentialRules } from '../security/confidential-rules.js';
import {
  type LeakScanReport,
  type PromptCategory,
  scanAllAuditSessionsForLeaks,
  scanAuditSessionForLeaks,
  summarizeLeakReports,
} from './leak-scanner.js';

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
): void {
  printBanner('Audit Leak Scanner');
  console.log(`Rules: ${rulesLoaded} from ${rulesPath ?? 'embedded'}`);
  console.log(`Scope: ${scope}`);
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
  const remaining = stripVerbosityFlags(args);
  const positional = remaining.filter((arg) => !arg.startsWith('--'));
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

  const reports = sessionId
    ? [scanAuditSessionForLeaks(sessionId, ruleSet)]
    : scanAllAuditSessionsForLeaks(ruleSet);

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

  printRunHeader(
    ruleSet.rules.length,
    ruleSet.sourcePath,
    sessionId
      ? `session ${sessionId}`
      : `${reports.length} session${reports.length === 1 ? '' : 's'}`,
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
