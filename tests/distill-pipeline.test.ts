import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DistillExtraction } from '../src/distill/types.js';

const ORIGINAL_HOME = process.env.HOME;

let tempHome: string;

async function loadModules() {
  vi.resetModules();
  return {
    consent: await import('../src/distill/consent.js'),
    corpus: await import('../src/distill/corpus.js'),
    corrections: await import('../src/distill/corrections.js'),
    evalMod: await import('../src/distill/eval.js'),
    exportMod: await import('../src/distill/export.js'),
    forget: await import('../src/distill/forget.js'),
    merge: await import('../src/distill/merge.js'),
    paths: await import('../src/distill/paths.js'),
    pipeline: await import('../src/distill/pipeline.js'),
    revisions: await import('../src/config/runtime-config-revisions.js'),
    skillManifest: await import('../src/skills/skill-manifest.js'),
    state: await import('../src/distill/state.js'),
    subject: await import('../src/distill/subject.js'),
    types: await import('../src/distill/types.js'),
  };
}

type Modules = Awaited<ReturnType<typeof loadModules>>;

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-distillp-'));
  process.env.HOME = tempHome;
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
});

function writeSource(name: string, content: string): string {
  const filePath = path.join(tempHome, 'sources', name);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function setupSubject(modules: Modules, options: { realPerson: boolean }) {
  const paths = modules.paths.resolveDistillPaths('maya', 'maya');
  const { profile } = modules.subject.ensureSubjectProfile(paths, {
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    realPerson: options.realPerson,
    matchAliases: ['maya@example.com'],
  });
  return { paths, profile };
}

function extractionFor(
  subject: string,
  runId: string,
  docId: string,
  extraClaims: DistillExtraction['claims'] = [],
): DistillExtraction {
  return {
    version: 1,
    subject,
    runId,
    identity: {
      name: 'Maya',
      creature: 'Distilled coworker',
      vibe: 'calm and direct',
      emoji: '🔧',
    },
    claims: [
      {
        dimension: 'decision-making',
        claim: 'Prefers the boring option until measurements demand otherwise.',
        evidence: [docId],
        confidence: 0.9,
      },
      {
        dimension: 'expression',
        claim: 'Writes down thresholds so future decisions cannot drift.',
        evidence: [docId],
        confidence: 0.8,
      },
      ...extraClaims,
    ],
    workModule: {
      skillName: 'maya-playbook',
      description: 'Work the way Maya works.',
      scope: ['persistence decisions'],
      workflows: [
        {
          title: 'Technology selection',
          steps: ['Default to the boring option.', 'Write down the revisit threshold.'],
          evidence: [docId],
        },
      ],
      outputPreferences: [
        {
          dimension: 'expression',
          claim: 'Decisions are written up with explicit revisit thresholds.',
          evidence: [docId],
          confidence: 0.8,
        },
      ],
      knowHow: [
        {
          topic: 'Persistence trade-offs',
          notes: 'SQLite suffices below ~50 writes/sec sustained.',
          evidence: [docId],
        },
      ],
      workedExamples: [
        {
          title: 'SQLite over Postgres',
          situation: 'Choosing gateway persistence.',
          approach: 'Picked SQLite for operational simplicity with a written revisit threshold.',
          evidence: [docId],
        },
      ],
    },
    userNotes: ['Expects pushback to come with workload numbers.'],
    openQuestions: ['How does Maya run incident retrospectives?'],
  };
}

test('distilling a real person without consent is blocked with remediation; fictional subjects pass', async () => {
  const modules = await loadModules();
  const { paths, profile } = setupSubject(modules, { realPerson: true });
  const source = writeSource('memo.md', '# Memo\n\nBoring options win.');
  expect(() =>
    modules.pipeline.runDistillPipeline(paths, profile, {
      sources: [{ path: source, kind: 'auto' }],
    }),
  ).toThrow(modules.types.DistillBlockedError);
  try {
    modules.pipeline.runDistillPipeline(paths, profile, {
      sources: [{ path: source, kind: 'auto' }],
    });
  } catch (error) {
    const blocked = error as InstanceType<
      typeof modules.types.DistillBlockedError
    >;
    expect(blocked.remediation).toContain('coworker consent record');
  }

  const fictional = setupSubject(modules, { realPerson: false });
  const result = modules.pipeline.runDistillPipeline(
    fictional.paths,
    fictional.profile,
    { sources: [{ path: source, kind: 'auto' }], holdoutRatio: 0 },
  );
  expect(result.run.stages.ingest.status).toBe('completed');
});

test('full pipeline: consent, ingest, awaiting-extraction, resume, merge with citation enforcement and F4 revisions', async () => {
  const modules = await loadModules();
  const { paths, profile } = setupSubject(modules, { realPerson: true });
  modules.consent.recordConsentArtefact(paths, {
    subjectName: 'Maya Lindqvist',
    grantedBy: 'Maya Lindqvist',
    method: 'written',
    statement: 'I consent to being distilled into a coworker agent.',
  });
  const source = writeSource(
    'memo.md',
    '# Persistence decision\n\nI always prefer the boring option until the numbers say otherwise. The revisit threshold is written down.',
  );

  const first = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [{ path: source, kind: 'auto' }],
    holdoutRatio: 0,
  });
  expect(first.status).toBe('awaiting-extraction');
  expect(fs.existsSync(first.runPaths.runRecordPath)).toBe(true);
  expect(fs.existsSync(first.runPaths.reportPath)).toBe(true);
  expect(fs.existsSync(first.runPaths.packetMarkdownPath)).toBe(true);

  const docId = modules.corpus.listCorpusDocuments(paths)[0].id;
  const extraction = extractionFor('maya', first.run.runId, docId, [
    {
      dimension: 'expression',
      claim: 'Signs every message with a haiku.',
      evidence: ['doc_does_not_exist'],
      confidence: 0.9,
    },
  ]);
  fs.writeFileSync(
    first.runPaths.extractionPath,
    JSON.stringify(extraction, null, 2),
    'utf-8',
  );

  const resumed = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [],
    resumeRunId: first.run.runId,
  });
  expect(resumed.status).toBe('completed');
  expect(resumed.run.stats.claimsFlagged).toBe(1);
  expect(resumed.run.stats.claimsAdded).toBe(2);
  expect(resumed.run.stats.documentsAdded).toBe(1);

  const soul = fs.readFileSync(path.join(paths.workspaceDir, 'SOUL.md'), 'utf-8');
  expect(soul).toContain('boring option');
  expect(soul).toContain(`<!-- ${docId} -->`);
  expect(soul).not.toContain('haiku');

  const report = fs.readFileSync(first.runPaths.reportPath, 'utf-8');
  expect(report).toContain('Flagged for operator review');
  expect(report).toContain('Signs every message with a haiku.');

  const skillMarkdown = fs.readFileSync(
    path.join(paths.workspaceDir, 'skills', 'maya-playbook', 'SKILL.md'),
    'utf-8',
  );
  const manifest = modules.skillManifest.parseSkillManifestFromMarkdown(
    skillMarkdown,
    { name: 'maya-playbook' },
  );
  expect(manifest.id).toBe('maya-playbook');
  expect(manifest.version).toBe('0.1.0');
  // Manifest parsing normalizes capability labels to slugs.
  expect(manifest.capabilities).toContain('persistence-decisions');

  const soulState = modules.revisions.getRuntimeAssetRevisionState(
    'template',
    path.join(paths.workspaceDir, 'SOUL.md'),
  );
  expect(soulState).not.toBeNull();

  // Resume of a completed run is a no-op, not a re-run.
  const idempotent = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [],
    resumeRunId: first.run.runId,
  });
  expect(idempotent.run.stats.claimsAdded).toBe(2);
});

async function buildMergedSubject(modules: Modules) {
  const { paths, profile } = setupSubject(modules, { realPerson: false });
  const source = writeSource(
    'memo.md',
    '# Persistence decision\n\nI always prefer the boring option until the numbers say otherwise.',
  );
  const first = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [{ path: source, kind: 'auto' }],
    holdoutRatio: 0,
  });
  const docId = modules.corpus.listCorpusDocuments(paths)[0].id;
  fs.writeFileSync(
    first.runPaths.extractionPath,
    JSON.stringify(extractionFor('maya', first.run.runId, docId), null, 2),
    'utf-8',
  );
  const resumed = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [],
    resumeRunId: first.run.runId,
  });
  return { paths, profile, docId, run: resumed.run };
}

test('a completed analyse stage with a missing packet fails loudly instead of merging nothing', async () => {
  const modules = await loadModules();
  const { paths, profile } = setupSubject(modules, { realPerson: false });
  const source = writeSource('memo.md', '# Memo\n\nBoring options win.');
  const first = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [{ path: source, kind: 'auto' }],
    holdoutRatio: 0,
  });
  expect(first.status).toBe('awaiting-extraction');
  fs.rmSync(first.runPaths.packetJsonPath);
  expect(() =>
    modules.pipeline.runDistillPipeline(paths, profile, {
      sources: [],
      resumeRunId: first.run.runId,
    }),
  ).toThrow(/Analysis packet missing or unreadable/);
});

test('setting a display name after creation merges it into the authorship aliases', async () => {
  const modules = await loadModules();
  const paths = modules.paths.resolveDistillPaths('maya', 'maya');
  modules.subject.ensureSubjectProfile(paths, { alias: 'maya' });
  const { profile } = modules.subject.ensureSubjectProfile(paths, {
    alias: 'maya',
    displayName: 'Maya Lindqvist',
  });
  expect(profile.displayName).toBe('Maya Lindqvist');
  expect(profile.matchAliases).toContain('Maya Lindqvist');
});

test('conflicting evidence opens a review item; resolution supersedes and re-renders', async () => {
  const modules = await loadModules();
  const { paths, profile } = await buildMergedSubject(modules);
  const standing = modules.state
    .loadDistillState(paths)
    .claims.find((claim) => claim.dimension === 'decision-making');
  expect(standing).toBeDefined();

  const newSource = writeSource(
    'memo2.md',
    '# New evidence\n\nLately I reach for the experimental option first and stabilise later.',
  );
  const second = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [{ path: newSource, kind: 'auto' }],
    holdoutRatio: 0,
  });
  const newDocId = modules.corpus
    .listCorpusDocuments(paths)
    .find((doc) => doc.origin.includes('memo2'))?.id as string;
  const extraction = extractionFor('maya', second.run.runId, newDocId);
  extraction.claims = [
    {
      dimension: 'decision-making',
      claim: 'Reaches for the experimental option first and stabilises later.',
      evidence: [newDocId],
      confidence: 0.8,
      conflictsWith: standing?.id,
    },
  ];
  fs.writeFileSync(
    second.runPaths.extractionPath,
    JSON.stringify(extraction, null, 2),
    'utf-8',
  );
  const resumed = modules.pipeline.runDistillPipeline(paths, profile, {
    sources: [],
    resumeRunId: second.run.runId,
  });
  expect(resumed.run.stats.reviewsOpened).toBe(1);

  // The conflicting claim is parked in review, not silently merged.
  const soulBefore = fs.readFileSync(
    path.join(paths.workspaceDir, 'SOUL.md'),
    'utf-8',
  );
  expect(soulBefore).toContain('boring option');
  expect(soulBefore).not.toContain('experimental option');

  const review = modules.merge
    .listReviewItems(paths)
    .find((item) => item.status === 'open');
  expect(review).toBeDefined();
  if (!review) throw new Error('expected an open review');
  modules.merge.resolveReviewItem(
    paths,
    profile,
    review.id,
    'accept-incoming',
    'operator',
  );
  const soulAfter = fs.readFileSync(
    path.join(paths.workspaceDir, 'SOUL.md'),
    'utf-8',
  );
  expect(soulAfter).toContain('experimental option');
  expect(soulAfter).not.toContain('boring option');
  const state = modules.state.loadDistillState(paths);
  expect(
    state.claims.find((claim) => claim.id === review.standingClaimId)?.status,
  ).toBe('superseded');
});

test('corrections become max-weight corpus documents and report as pending until analysed', async () => {
  const modules = await loadModules();
  const { paths, profile } = await buildMergedSubject(modules);
  const record = modules.corrections.recordCorrection(paths, profile, {
    text: 'Maya never opens messages with a greeting.',
    recordedBy: 'operator',
  });
  expect(record.docId).toMatch(/^doc_/);
  const doc = modules.corpus
    .listCorpusDocuments(paths)
    .find((entry) => entry.id === record.docId);
  expect(doc?.weight).toBe(1);
  expect(doc?.source).toBe('correction');
  expect(modules.corrections.pendingCorrections(paths)).toHaveLength(1);
});

test('holdout split is deterministic and holdouts never enter the analysis packet', async () => {
  const modules = await loadModules();
  const { evalMod } = modules;
  const docs = Array.from({ length: 50 }, (_, index) => ({
    id: `doc_${index.toString(16).padStart(12, '0')}`,
    subject: 'maya',
    source: 'text' as const,
    origin: `doc-${index}`,
    author: 'maya',
    authoredBySubject: true,
    content: `content ${index}`,
    wordCount: 2,
    weight: 0.8,
    maskedThirdParties: 0,
    ingestedAt: new Date().toISOString(),
  }));
  const once = evalMod.markHoldoutDocuments(docs, 0.2);
  const twice = evalMod.markHoldoutDocuments(docs, 0.2);
  expect(once.map((doc) => Boolean(doc.holdout))).toEqual(
    twice.map((doc) => Boolean(doc.holdout)),
  );
  expect(once.some((doc) => doc.holdout)).toBe(true);
  expect(once.some((doc) => !doc.holdout)).toBe(true);
});

test('leakage scan flags third-party emails and citations of unknown documents', async () => {
  const modules = await loadModules();
  const { paths, profile } = await buildMergedSubject(modules);
  const clean = modules.evalMod.runLeakageScan(paths, profile);
  expect(clean).toHaveLength(0);

  const soulPath = path.join(paths.workspaceDir, 'SOUL.md');
  fs.appendFileSync(
    soulPath,
    '\n- Always cc victim@thirdparty.example.com first. <!-- doc_ffffffffffff -->\n',
  );
  const findings = modules.evalMod.runLeakageScan(paths, profile);
  expect(
    findings.some((finding) => finding.kind === 'third-party-email'),
  ).toBe(true);
  expect(findings.some((finding) => finding.kind === 'uncited-source')).toBe(
    true,
  );
});

test('export bundles persona + skill, installs per host, and round-trips via import', async () => {
  const modules = await loadModules();
  const { paths, profile } = await buildMergedSubject(modules);
  const outDir = path.join(tempHome, 'exports');
  const { bundleDir, manifest } = modules.exportMod.exportCoworkerBundle(
    paths,
    profile,
    outDir,
  );
  expect(manifest.skillName).toBe('maya-playbook');
  expect(manifest.includesCorpus).toBe(false);
  expect(
    fs.existsSync(path.join(bundleDir, 'corpus', 'documents.jsonl')),
  ).toBe(false);

  const fakeHome = path.join(tempHome, 'other-host-home');
  const installed = modules.exportMod.installCoworkerBundle(
    bundleDir,
    'claude-code',
    fakeHome,
  );
  expect(installed.installedTo).toBe(
    path.join(fakeHome, '.claude', 'skills', 'maya-playbook'),
  );
  expect(fs.existsSync(path.join(installed.installedTo, 'SKILL.md'))).toBe(
    true,
  );
  expect(
    fs.existsSync(
      path.join(installed.installedTo, 'references', 'persona', 'SOUL.md'),
    ),
  ).toBe(true);
  const codex = modules.exportMod.installCoworkerBundle(
    bundleDir,
    'codex',
    fakeHome,
  );
  expect(codex.installedTo).toBe(
    path.join(fakeHome, '.codex', 'skills', 'maya-playbook'),
  );

  const importPaths = modules.paths.resolveDistillPaths('maya-clone', 'maya');
  const imported = modules.exportMod.importCoworkerBundle(
    bundleDir,
    importPaths,
  );
  expect(imported.claims).toBe(manifest.claims);
  const importedState = modules.state.loadDistillState(importPaths);
  expect(
    importedState.claims.filter((claim) => claim.status === 'standing'),
  ).toHaveLength(manifest.claims);
  expect(
    fs.readFileSync(path.join(importPaths.workspaceDir, 'SOUL.md'), 'utf-8'),
  ).toContain('boring option');
});

test('forget removes corpus, persona, work module, runs, and their revision snapshots', async () => {
  const modules = await loadModules();
  const { paths, profile } = await buildMergedSubject(modules);
  const soulPath = path.join(paths.workspaceDir, 'SOUL.md');
  expect(fs.existsSync(soulPath)).toBe(true);
  const result = modules.forget.forgetDistilledSubject(paths, 'operator');
  expect(result.clearedRevisions).toBeGreaterThan(0);
  expect(fs.existsSync(paths.subjectDir)).toBe(false);
  expect(fs.existsSync(soulPath)).toBe(false);
  expect(
    fs.existsSync(path.join(paths.workspaceDir, 'skills', 'maya-playbook')),
  ).toBe(false);
  expect(fs.existsSync(paths.runsRootDir)).toSatisfy(
    (exists: boolean) =>
      !exists || fs.readdirSync(paths.runsRootDir).length === 0,
  );
  expect(
    modules.revisions.listRuntimeAssetRevisions('template', soulPath),
  ).toHaveLength(0);
  void profile;
});
