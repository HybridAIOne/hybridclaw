import fs from 'node:fs';
import path from 'node:path';
import { collectSourcePath } from '../distill/collectors.js';
import {
  loadConsentArtefact,
  recordConsentArtefact,
  revokeConsentArtefact,
} from '../distill/consent.js';
import {
  appendCorpusDocuments,
  listCorpusDocuments,
} from '../distill/corpus.js';
import {
  pendingCorrections,
  recordCorrection,
} from '../distill/corrections.js';
import { markHoldoutDocuments, runDistillEval } from '../distill/eval.js';
import type { CoworkerExportHost } from '../distill/export.js';
import {
  COWORKER_EXPORT_HOSTS,
  exportCoworkerBundle,
  importCoworkerBundle,
  installCoworkerBundle,
} from '../distill/export.js';
import { forgetDistilledSubject } from '../distill/forget.js';
import { generateQuestionnaire } from '../distill/interview.js';
import { listReviewItems, resolveReviewItem } from '../distill/merge.js';
import type { DistillPaths } from '../distill/paths.js';
import { resolveDistillPaths } from '../distill/paths.js';
import { runDistillPipeline } from '../distill/pipeline.js';
import { findLatestDistillRun, loadDistillRun } from '../distill/run.js';
import { loadDistillState } from '../distill/state.js';
import {
  ensureSubjectProfile,
  loadSubjectProfile,
  requireSubjectProfile,
} from '../distill/subject.js';
import type {
  CorpusSourceKind,
  DistillRunSource,
  SubjectProfile,
} from '../distill/types.js';
import { DISTILL_STAGE_ORDER, DistillBlockedError } from '../distill/types.js';
import { normalizeArgs, parseValueFlag } from './common.js';
import { isHelpRequest, printCoworkerUsage } from './help.js';

const SOURCE_KINDS: ReadonlySet<string> = new Set([
  'auto',
  'slack-export',
  'email-mbox',
  'transcript',
  'chat-jsonl',
  'markdown',
  'text',
  'interview',
]);

interface CoworkerFlags {
  alias?: string;
  agent?: string;
  name?: string;
  role?: string;
  relationship?: string;
  tags: string[];
  matchAliases: string[];
  sources: string[];
  kind: string;
  fictional: boolean;
  resume?: string;
  holdout?: number;
  grantedBy?: string;
  method?: string;
  statement?: string;
  scope?: string;
  note?: string;
  by?: string;
  id?: string;
  keep?: string;
  out?: string;
  host?: string;
  bundle?: string;
  includeCorpus: boolean;
  audience?: string;
  count?: number;
  confirm: boolean;
  positional: string[];
}

function parseCoworkerFlags(args: string[]): CoworkerFlags {
  const flags: CoworkerFlags = {
    tags: [],
    matchAliases: [],
    sources: [],
    kind: 'auto',
    fictional: false,
    includeCorpus: false,
    confirm: false,
    positional: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--fictional') {
      flags.fictional = true;
      continue;
    }
    if (arg === '--include-corpus') {
      flags.includeCorpus = true;
      continue;
    }
    if (arg === '--confirm') {
      flags.confirm = true;
      continue;
    }
    const valueFlags: [string, (value: string) => void][] = [
      ['--alias', (value) => (flags.alias = value)],
      ['--agent', (value) => (flags.agent = value)],
      ['--name', (value) => (flags.name = value)],
      ['--role', (value) => (flags.role = value)],
      ['--relationship', (value) => (flags.relationship = value)],
      ['--tag', (value) => flags.tags.push(value)],
      ['--match-alias', (value) => flags.matchAliases.push(value)],
      ['--source', (value) => flags.sources.push(value)],
      ['--kind', (value) => (flags.kind = value)],
      ['--resume', (value) => (flags.resume = value)],
      ['--holdout', (value) => (flags.holdout = parseHoldoutRatio(value))],
      ['--granted-by', (value) => (flags.grantedBy = value)],
      ['--method', (value) => (flags.method = value)],
      ['--statement', (value) => (flags.statement = value)],
      ['--scope', (value) => (flags.scope = value)],
      ['--note', (value) => (flags.note = value)],
      ['--by', (value) => (flags.by = value)],
      ['--id', (value) => (flags.id = value)],
      ['--keep', (value) => (flags.keep = value)],
      ['--out', (value) => (flags.out = value)],
      ['--host', (value) => (flags.host = value)],
      ['--bundle', (value) => (flags.bundle = value)],
      ['--audience', (value) => (flags.audience = value)],
      ['--count', (value) => (flags.count = parseQuestionCount(value))],
    ];
    let matched = false;
    for (const [name, assign] of valueFlags) {
      const parsed = parseValueFlag({
        arg,
        args,
        index,
        name,
        placeholder: '<value>',
      });
      if (parsed) {
        assign(parsed.value);
        index = parsed.nextIndex;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    if (arg.startsWith('-')) {
      throw new Error(`Unknown coworker flag: ${arg}`);
    }
    flags.positional.push(arg);
  }
  return flags;
}

function resolveSubjectContext(flags: CoworkerFlags): {
  paths: DistillPaths;
  profile: SubjectProfile;
} {
  if (!flags.alias) {
    throw new Error('Missing `--alias <coworker-alias>`.');
  }
  const paths = resolveDistillPaths(flags.agent || flags.alias, flags.alias);
  const profile = requireSubjectProfile(paths);
  return { paths, profile };
}

function parseHoldoutRatio(value: string): number {
  const ratio = Number(value);
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 0.5) {
    throw new Error(
      `Invalid \`--holdout\` value: ${value}. Use a fraction between 0 and 0.5 (e.g. 0.1).`,
    );
  }
  return ratio;
}

function parseQuestionCount(value: string): number {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error(
      `Invalid \`--count\` value: ${value}. Use a whole number between 1 and 20.`,
    );
  }
  return count;
}

function parseSourceKind(value: string): CorpusSourceKind | 'auto' {
  if (!SOURCE_KINDS.has(value)) {
    throw new Error(
      `Unsupported source kind: ${value}. Use one of: ${[...SOURCE_KINDS].join(', ')}.`,
    );
  }
  return value as CorpusSourceKind | 'auto';
}

export async function handleCoworkerCommand(args: string[]): Promise<void> {
  const normalized = normalizeArgs(args);
  if (normalized.length === 0 || isHelpRequest(normalized)) {
    printCoworkerUsage();
    return;
  }
  const sub = normalized[0].toLowerCase();
  const rest = normalized.slice(1);

  try {
    if (sub === 'distill') return runDistillCommand(rest);
    if (sub === 'consent') return runConsentCommand(rest);
    if (sub === 'sources') return runSourcesCommand(rest);
    if (sub === 'interview') return runInterviewCommand(rest);
    if (sub === 'status') return runStatusCommand(rest);
    if (sub === 'correct') return runCorrectCommand(rest);
    if (sub === 'review') return runReviewCommand(rest);
    if (sub === 'eval') return runEvalCommand(rest);
    if (sub === 'export') return runExportCommand(rest);
    if (sub === 'import') return runImportCommand(rest);
    if (sub === 'forget') return runForgetCommand(rest);
  } catch (error) {
    if (error instanceof DistillBlockedError) {
      console.error(error.message);
      console.error('');
      console.error(error.remediation);
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  printCoworkerUsage();
  throw new Error(`Unknown coworker subcommand: ${sub}`);
}

function runDistillCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  if (!flags.alias) {
    throw new Error(
      'Usage: hybridclaw coworker distill --alias <alias> [--name "<display name>"] --source <path> [...]',
    );
  }
  const paths = resolveDistillPaths(flags.agent || flags.alias, flags.alias);
  const { profile, created } = ensureSubjectProfile(paths, {
    alias: flags.alias,
    displayName: flags.name,
    realPerson: flags.fictional ? false : undefined,
    role: flags.role,
    relationship: flags.relationship,
    personalityTags: flags.tags,
    matchAliases: flags.matchAliases,
  });
  if (created) {
    console.log(
      `Created coworker subject \`${paths.subject}\` (${profile.displayName}${profile.realPerson ? ', real person' : ', fictional'}).`,
    );
  }
  if (!flags.resume && flags.sources.length === 0) {
    throw new Error(
      'Provide at least one `--source <path>` (or `--resume <run-id>` to continue a run).',
    );
  }
  const kind = parseSourceKind(flags.kind);
  const sources: DistillRunSource[] = flags.sources.map((source) => ({
    path: source,
    kind,
  }));
  const result = runDistillPipeline(paths, profile, {
    sources,
    resumeRunId: flags.resume,
    holdoutRatio: flags.holdout,
  });
  console.log(`Run \`${result.run.runId}\` — ${result.status}`);
  for (const stage of DISTILL_STAGE_ORDER) {
    const state = result.run.stages[stage];
    console.log(
      `  ${stage}: ${state.status}${state.detail ? ` — ${state.detail}` : ''}`,
    );
  }
  for (const warning of result.warnings) {
    console.log(`  warning: ${warning}`);
  }
  console.log(`Report: ${result.runPaths.reportPath}`);
  if (result.status === 'awaiting-extraction') {
    console.log('');
    console.log(
      `Next: have the analysing agent read ${result.runPaths.packetMarkdownPath}`,
    );
    console.log(
      `and write ${result.runPaths.extractionPath}, then resume with:`,
    );
    console.log(
      `  hybridclaw coworker distill --alias ${paths.subject} --resume ${result.run.runId}`,
    );
  }
}

function runConsentCommand(args: string[]): void {
  const action = (args[0] || '').toLowerCase();
  const flags = parseCoworkerFlags(args.slice(1));
  if (!flags.alias) {
    throw new Error('Missing `--alias <coworker-alias>`.');
  }
  const paths = resolveDistillPaths(flags.agent || flags.alias, flags.alias);
  if (action === 'record') {
    const profile = loadSubjectProfile(paths);
    const artefact = recordConsentArtefact(paths, {
      subjectName: flags.name || profile?.displayName || paths.subject,
      grantedBy: flags.grantedBy || '',
      method: flags.method || '',
      statement: flags.statement || '',
      scope: flags.scope,
      note: flags.note,
    });
    console.log(
      `Recorded consent for \`${paths.subject}\` (granted by ${artefact.grantedBy}, ${artefact.method}).`,
    );
    console.log(`Artefact: ${paths.consentPath}`);
    console.log(`Digest: ${artefact.sha256}`);
    return;
  }
  if (action === 'show') {
    const artefact = loadConsentArtefact(paths);
    if (!artefact) {
      console.log(`No consent artefact recorded for \`${paths.subject}\`.`);
      return;
    }
    console.log(JSON.stringify(artefact, null, 2));
    return;
  }
  if (action === 'revoke') {
    const artefact = revokeConsentArtefact(paths);
    console.log(
      `Consent for \`${paths.subject}\` revoked at ${artefact.revokedAt}. Future distillation runs are blocked.`,
    );
    console.log(
      `To erase the subject entirely, run: hybridclaw coworker forget --alias ${paths.subject} --confirm`,
    );
    return;
  }
  throw new Error(
    'Usage: hybridclaw coworker consent <record|show|revoke> --alias <alias> [...]',
  );
}

function runSourcesCommand(args: string[]): void {
  const action = (args[0] || '').toLowerCase();
  if (action !== 'add') {
    throw new Error(
      'Usage: hybridclaw coworker sources add --alias <alias> [--kind <kind>] <path> [...]',
    );
  }
  const flags = parseCoworkerFlags(args.slice(1));
  const { paths, profile } = resolveSubjectContext(flags);
  const inputs = [...flags.sources, ...flags.positional];
  if (inputs.length === 0) {
    throw new Error('Provide at least one source path.');
  }
  const kind = parseSourceKind(flags.kind);
  let added = 0;
  let duplicates = 0;
  for (const input of inputs) {
    const collected = collectSourcePath(input, kind, {
      subject: paths.subject,
      matchAliases: profile.matchAliases,
    });
    for (const warning of collected.warnings) {
      console.log(`warning: ${warning}`);
    }
    const marked = markHoldoutDocuments(
      collected.documents,
      flags.holdout ?? 0.1,
    );
    const result = appendCorpusDocuments(paths, marked, 'manual');
    added += result.added.length;
    duplicates += result.skippedDuplicates;
  }
  console.log(
    `Added ${added} document(s) to the \`${paths.subject}\` corpus (${duplicates} duplicates skipped).`,
  );
  console.log(
    `Run \`hybridclaw coworker distill --alias ${paths.subject} --source ${inputs[0]}\` (or resume a run) to analyse the delta.`,
  );
}

function runInterviewCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  const audience = flags.audience === 'colleague' ? 'colleague' : 'subject';
  const questionnaire = generateQuestionnaire(paths, profile, {
    audience,
    count: flags.count,
  });
  if (flags.out) {
    fs.mkdirSync(path.dirname(path.resolve(flags.out)), { recursive: true });
    fs.writeFileSync(flags.out, questionnaire, 'utf-8');
    console.log(`Wrote ${audience} questionnaire to ${flags.out}`);
    console.log(
      `When answered, ingest it with: hybridclaw coworker sources add --alias ${paths.subject} --kind interview ${flags.out}`,
    );
  } else {
    console.log(questionnaire);
  }
}

function runStatusCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  const documents = listCorpusDocuments(paths);
  const state = loadDistillState(paths);
  const consent = loadConsentArtefact(paths);
  const standing = state.claims.filter((claim) => claim.status === 'standing');
  console.log(`Coworker: ${profile.displayName} (\`${paths.subject}\`)`);
  console.log(
    `Subject type: ${profile.realPerson ? 'real person' : 'fictional / composite'}`,
  );
  console.log(
    `Consent: ${
      consent
        ? consent.revokedAt
          ? `revoked ${consent.revokedAt}`
          : `recorded ${consent.recordedAt} by ${consent.grantedBy}`
        : 'not recorded'
    }`,
  );
  console.log(
    `Corpus: ${documents.length} documents (${documents.filter((doc) => doc.holdout).length} held out for eval, ${state.analysedDocIds.length} analysed)`,
  );
  console.log(`Standing claims: ${standing.length}`);
  console.log(`Merges: ${state.mergeHistory.length}`);
  const run = flags.id
    ? loadDistillRun(paths, flags.id)
    : findLatestDistillRun(paths);
  if (run) {
    console.log(`Latest run: ${run.run.runId}`);
    for (const stage of DISTILL_STAGE_ORDER) {
      const stageState = run.run.stages[stage];
      console.log(
        `  ${stage}: ${stageState.status}${stageState.detail ? ` — ${stageState.detail}` : ''}`,
      );
    }
  }
  const openReviews = listReviewItems(paths).filter(
    (review) => review.status === 'open',
  );
  if (openReviews.length > 0) {
    console.log(`Open reviews: ${openReviews.length}`);
    for (const review of openReviews) {
      console.log(
        `  ${review.id} [${review.dimension}] "${review.standingClaim}" vs "${review.incomingClaim}"`,
      );
    }
  }
  const pending = pendingCorrections(paths);
  if (pending.length > 0) {
    console.log(`Pending corrections: ${pending.length}`);
  }
}

function runCorrectCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  const scope =
    flags.scope === 'persona' || flags.scope === 'work' ? flags.scope : 'both';
  const record = recordCorrection(paths, profile, {
    text: flags.note || flags.positional.join(' '),
    scope,
    recordedBy: flags.by || 'operator',
  });
  console.log(`Recorded correction \`${record.id}\` (${record.scope}).`);
  console.log(
    `It is now a maximum-weight corpus document; the next distill run will promote it into the persona/work files.`,
  );
}

function runReviewCommand(args: string[]): void {
  const action = (args[0] || '').toLowerCase();
  const flags = parseCoworkerFlags(args.slice(1));
  const { paths, profile } = resolveSubjectContext(flags);
  if (action === 'list') {
    const reviews = listReviewItems(paths);
    if (reviews.length === 0) {
      console.log('No review items.');
      return;
    }
    for (const review of reviews) {
      console.log(
        `${review.id} [${review.status}] (${review.dimension})\n  standing: ${review.standingClaim}\n  incoming: ${review.incomingClaim}${review.resolution ? `\n  resolution: ${review.resolution}` : ''}`,
      );
    }
    return;
  }
  if (action === 'resolve') {
    if (!flags.id) {
      throw new Error('Missing `--id <review-id>`.');
    }
    const keep = flags.keep || '';
    const resolution =
      keep === 'standing'
        ? 'keep-standing'
        : keep === 'incoming'
          ? 'accept-incoming'
          : keep === 'both'
            ? 'keep-both'
            : null;
    if (!resolution) {
      throw new Error('Use `--keep standing|incoming|both`.');
    }
    const review = resolveReviewItem(
      paths,
      profile,
      flags.id,
      resolution,
      flags.by || 'operator',
    );
    console.log(`Resolved ${review.id}: ${review.resolution}.`);
    return;
  }
  throw new Error(
    'Usage: hybridclaw coworker review <list|resolve> --alias <alias> [...]',
  );
}

function runEvalCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  const latest = findLatestDistillRun(paths);
  const evalPath = latest
    ? latest.runPaths.evalPath
    : path.join(paths.subjectDir, 'eval.json');
  const result = runDistillEval(paths, profile, evalPath);
  console.log(
    `Leakage: ${result.leakage.passed ? 'PASS' : `FAIL (${result.leakage.findings.length} finding(s))`}`,
  );
  for (const finding of result.leakage.findings) {
    console.log(`  ${finding.file}: [${finding.kind}] ${finding.detail}`);
  }
  console.log(
    `Fidelity: ${result.fidelity.promptsPrepared} held-out prompt(s) prepared from ${result.fidelity.holdoutDocuments} holdout document(s).`,
  );
  console.log(`Details: ${evalPath}`);
  if (!result.leakage.passed) {
    process.exitCode = 1;
  }
}

function runExportCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  const outDir = path.resolve(flags.out || 'exports');
  const { bundleDir, manifest } = exportCoworkerBundle(paths, profile, outDir, {
    includeCorpus: flags.includeCorpus,
  });
  console.log(
    `Exported coworker bundle to ${bundleDir} (${manifest.files.length} files, ${manifest.claims} standing claims).`,
  );
  if (flags.host) {
    const host = flags.host as CoworkerExportHost;
    if (!COWORKER_EXPORT_HOSTS.includes(host)) {
      throw new Error(
        `Unsupported host: ${flags.host}. Use one of: ${COWORKER_EXPORT_HOSTS.join(', ')}.`,
      );
    }
    const installed = installCoworkerBundle(bundleDir, host);
    console.log(`Installed for ${host}: ${installed.installedTo}`);
  }
}

function runImportCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  if (!flags.alias) {
    throw new Error('Missing `--alias <coworker-alias>`.');
  }
  if (!flags.bundle) {
    throw new Error('Missing `--bundle <bundle-dir>`.');
  }
  const paths = resolveDistillPaths(flags.agent || flags.alias, flags.alias);
  const manifest = importCoworkerBundle(path.resolve(flags.bundle), paths);
  console.log(
    `Imported coworker \`${manifest.displayName}\` into agent workspace \`${paths.agentId}\` (${manifest.claims} standing claims).`,
  );
}

function runForgetCommand(args: string[]): void {
  const flags = parseCoworkerFlags(args);
  const { paths, profile } = resolveSubjectContext(flags);
  if (!flags.confirm) {
    throw new Error(
      `Forgetting \`${profile.displayName}\` removes the corpus, persona files, work module, runs, and their revision history. Re-run with --confirm to proceed.`,
    );
  }
  const result = forgetDistilledSubject(paths, flags.by || 'operator');
  console.log(
    `Forgot \`${paths.subject}\`: removed ${result.removedPaths.length} path(s), cleared ${result.clearedRevisions} revision snapshot(s).`,
  );
  for (const removed of result.removedPaths) {
    console.log(`  removed: ${removed}`);
  }
  console.log(
    'The erasure event itself remains in the audit trail (append-only).',
  );
}
