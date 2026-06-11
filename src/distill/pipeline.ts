import type { AnalysisPacket } from './analysis.js';
import {
  buildAnalysisPacket,
  loadExtraction,
  summarizeDelta,
  validateExtraction,
} from './analysis.js';
import { collectSourcePath } from './collectors.js';
import { assertDistillConsent } from './consent.js';
import { appendCorpusDocuments, listCorpusDocuments } from './corpus.js';
import { pendingCorrections } from './corrections.js';
import { markHoldoutDocuments } from './eval.js';
import { applyDistillMerge, listReviewItems } from './merge.js';
import type { DistillPaths, DistillRunPaths } from './paths.js';
import { readJsonFile } from './paths.js';
import {
  createDistillRun,
  loadDistillRun,
  setDistillStage,
  writeRunReport,
} from './run.js';
import type {
  DistillRunRecord,
  DistillRunSource,
  SubjectProfile,
} from './types.js';

export interface DistillPipelineOptions {
  sources: DistillRunSource[];
  resumeRunId?: string;
  /** Fraction of ingested documents reserved for fidelity eval. */
  holdoutRatio?: number;
}

export interface DistillPipelineResult {
  run: DistillRunRecord;
  runPaths: DistillRunPaths;
  status: 'completed' | 'awaiting-extraction';
  warnings: string[];
  flagged: string[];
}

/**
 * R72.1 orchestration: ingest → analyse → build → merge → correct, each
 * stage individually resumable. A killed run resumes from the last completed
 * stage; the build stage parks as `awaiting-extraction` until the analysing
 * agent writes `extraction.json` next to the packet.
 */
export function runDistillPipeline(
  paths: DistillPaths,
  profile: SubjectProfile,
  options: DistillPipelineOptions,
): DistillPipelineResult {
  let run: DistillRunRecord;
  let runPaths: DistillRunPaths;
  if (options.resumeRunId) {
    const loaded = loadDistillRun(paths, options.resumeRunId);
    if (!loaded) {
      throw new Error(`Distill run not found: ${options.resumeRunId}`);
    }
    ({ run, runPaths } = loaded);
    assertDistillConsent(paths, profile, run.runId);
  } else {
    // The consent gate runs before any run record exists; a blocked attempt
    // leaves an audit event, not a half-created run.
    assertDistillConsent(paths, profile, 'pre-run');
    ({ run, runPaths } = createDistillRun(paths, options.sources));
  }

  const warnings: string[] = [];
  const flagged: string[] = [];

  if (run.stages.ingest.status !== 'completed') {
    let added = 0;
    let duplicates = 0;
    for (const source of run.sources) {
      const collected = collectSourcePath(source.path, source.kind, {
        subject: paths.subject,
        matchAliases: profile.matchAliases,
      });
      warnings.push(...collected.warnings);
      const marked = markHoldoutDocuments(
        collected.documents,
        options.holdoutRatio ?? 0.1,
      ).map((doc) => ({ ...doc, runId: run.runId }));
      const result = appendCorpusDocuments(paths, marked, run.runId);
      added += result.added.length;
      duplicates += result.skippedDuplicates;
    }
    run.stats.documentsAdded = added;
    run.stats.documentsTotal = listCorpusDocuments(paths).length;
    setDistillStage(
      runPaths,
      run,
      'ingest',
      'completed',
      `${added} documents added (${duplicates} duplicates skipped) from ${run.sources.length} source(s)`,
    );
  } else {
    run.stats.documentsTotal = listCorpusDocuments(paths).length;
  }

  if (run.stages.analyse.status !== 'completed') {
    const packet = buildAnalysisPacket(paths, runPaths, profile, run.runId);
    run.stats.deltaDocuments = packet.deltaDocuments.length;
    setDistillStage(
      runPaths,
      run,
      'analyse',
      'completed',
      `delta of ${packet.deltaDocuments.length} document(s) packaged (${summarizeDelta(
        listCorpusDocuments(paths).filter((doc) =>
          packet.deltaDocuments.some((delta) => delta.id === doc.id),
        ),
      )})`,
    );
  }

  const packet = readJsonFile<AnalysisPacket>(runPaths.packetJsonPath);
  if (!packet || !Array.isArray(packet.deltaDocuments)) {
    // A completed analyse stage without a readable packet means the run
    // directory was tampered with or partially lost — fail loudly instead of
    // silently treating it as "no new material".
    throw new Error(
      `Analysis packet missing or unreadable: ${runPaths.packetJsonPath}. Start a fresh run with \`hybridclaw coworker distill --alias ${paths.subject} --source <path>\` to rebuild it.`,
    );
  }
  const deltaIds = packet.deltaDocuments.map((doc) => doc.id);

  if (run.stages.build.status !== 'completed') {
    if (deltaIds.length === 0) {
      setDistillStage(
        runPaths,
        run,
        'build',
        'completed',
        'no new material to analyse',
      );
    } else {
      const extraction = loadExtraction(runPaths);
      if (!extraction) {
        setDistillStage(
          runPaths,
          run,
          'build',
          'awaiting-extraction',
          `waiting for ${runPaths.extractionPath}`,
        );
        writeRunReport(runPaths, run, profile, {
          warnings,
          nextSteps: [
            `Have the analysing agent read \`${runPaths.packetMarkdownPath}\` and write \`${runPaths.extractionPath}\` (see the \`human-distill\` skill).`,
            `Then resume with \`hybridclaw coworker distill --alias ${paths.subject} --resume ${run.runId}\`.`,
          ],
        });
        return {
          run,
          runPaths,
          status: 'awaiting-extraction',
          warnings,
          flagged,
        };
      }
      const validation = validateExtraction(paths, extraction);
      run.stats.claimsFlagged = validation.flagged.length;
      flagged.push(
        ...validation.flagged.map(
          (entry) => `${entry.claim} — ${entry.reason}`,
        ),
      );
      setDistillStage(
        runPaths,
        run,
        'build',
        'completed',
        `${validation.validClaims.length} claims validated, ${validation.flagged.length} flagged`,
      );
    }
  }

  if (run.stages.merge.status !== 'completed') {
    if (deltaIds.length === 0) {
      setDistillStage(runPaths, run, 'merge', 'completed', 'nothing to merge');
    } else {
      const extraction = loadExtraction(runPaths);
      if (!extraction) {
        throw new Error(
          `Extraction disappeared before merge: ${runPaths.extractionPath}`,
        );
      }
      const validation = validateExtraction(paths, extraction);
      const result = applyDistillMerge(
        paths,
        profile,
        validation,
        deltaIds,
        run.runId,
      );
      run.stats.claimsAdded = result.claimsAdded;
      run.stats.reviewsOpened = result.reviewsOpened;
      setDistillStage(
        runPaths,
        run,
        'merge',
        'completed',
        `${result.claimsAdded} claims merged, ${result.reviewsOpened} review(s) opened, ${result.filesWritten.length} files written`,
      );
    }
  }

  if (run.stages.correct.status !== 'completed') {
    const pending = pendingCorrections(paths);
    setDistillStage(
      runPaths,
      run,
      'correct',
      'completed',
      pending.length === 0
        ? 'no pending corrections'
        : `${pending.length} correction(s) queued for the next analyse cycle`,
    );
  }

  const openReviews = listReviewItems(paths).filter(
    (review) => review.status === 'open',
  );
  writeRunReport(runPaths, run, profile, {
    warnings,
    flagged,
    reviews: openReviews.map(
      (review) =>
        `\`${review.id}\` [${review.dimension}] standing: "${review.standingClaim}" vs incoming: "${review.incomingClaim}"`,
    ),
    nextSteps: openReviews.length
      ? [
          `Resolve conflicting evidence with \`hybridclaw coworker review resolve --alias ${paths.subject} --id <review-id> --keep standing|incoming|both\`.`,
        ]
      : undefined,
  });
  return { run, runPaths, status: 'completed', warnings, flagged };
}
