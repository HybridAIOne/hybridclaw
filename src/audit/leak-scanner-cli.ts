import type { ConfidentialFinding } from '../security/confidential-redact.js';
import { loadConfidentialRules } from '../security/confidential-rules.js';
import {
  type LeakScanReport,
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
    console.log(
      `  #${record.seq} ${record.timestamp} ${record.eventType} ${sevTag} score=${record.score}${placeholder}`,
    );
    for (const finding of record.findings) {
      console.log(
        `    - [${finding.sensitivity}] ${finding.kind}:${finding.label} ×${finding.matches}  ${highlightExcerpt(finding.excerpt)}`,
      );
    }
  }
}

function printSummaryFooter(reports: LeakScanReport[]): void {
  const summary = summarizeLeakReports(reports);
  const order: ConfidentialFinding['sensitivity'][] = [
    'critical',
    'high',
    'medium',
    'low',
  ];
  console.log('');
  console.log(
    color('Summary', ANSI_BOLD) +
      ` — ${summary.affectedSessions}/${summary.totalSessions} session${summary.totalSessions === 1 ? '' : 's'} affected, ${summary.totalMatches} match${summary.totalMatches === 1 ? '' : 'es'} total`,
  );
  for (const severity of order) {
    const count = summary.bySeverity[severity];
    const label = color(
      severity.toUpperCase().padEnd(8),
      severityColor(severity),
    );
    console.log(`  ${label} ${count} session${count === 1 ? '' : 's'}`);
  }
}

export async function runLeakScanCli(args: string[]): Promise<void> {
  const useJson = args.includes('--json');
  const positional = args.filter((arg) => !arg.startsWith('--'));
  const sessionId = positional[0];

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

  console.log(
    `Scanning audit logs (${ruleSet.rules.length} rule${ruleSet.rules.length === 1 ? '' : 's'} from ${ruleSet.sourcePath ?? 'embedded'})`,
  );

  if (reports.length === 0) {
    console.log('No audit sessions found.');
    return;
  }

  let leaksFound = false;
  for (const report of reports) {
    console.log(summarizeReport(report));
    if (report.totalMatches > 0) leaksFound = true;
    printReportDetail(report);
  }

  printSummaryFooter(reports);

  if (leaksFound) {
    process.exitCode = 2;
  }
}
