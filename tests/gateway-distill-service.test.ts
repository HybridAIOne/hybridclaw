import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const ORIGINAL_HOME = process.env.HOME;

let tempHome: string;

async function loadService(options?: { initDatabase?: boolean }) {
  vi.resetModules();
  if (options?.initDatabase) {
    const { initDatabase } = await import('../src/memory/db.js');
    initDatabase({ quiet: true });
  }
  return import('../src/gateway/gateway-distill-service.js');
}

beforeEach(() => {
  tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-admin-distill-'));
  process.env.HOME = tempHome;
  process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = '1';
});

afterEach(() => {
  process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(tempHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

test('admin distill service registers a distill subject as an agent', async () => {
  const service = await loadService({ initDatabase: true });

  service.upsertGatewayAdminDistillSubject({
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    role: 'Architect',
    realPerson: true,
  });

  const registered = service.registerGatewayAdminDistillAgent({
    alias: 'maya',
  });
  expect(registered.registeredAgent).toBe(true);

  const { getAgentById } = await import('../src/agents/agent-registry.js');
  expect(getAgentById('maya')).toMatchObject({
    id: 'maya',
    name: 'Maya Lindqvist',
    role: 'Architect',
  });
});

test('admin distill registration backfills MEMORY.md from distilled state', async () => {
  const service = await loadService({ initDatabase: true });
  const { resolveDistillPaths } = await import('../src/distill/paths.js');
  const { saveDistillState } = await import('../src/distill/state.js');
  const now = new Date().toISOString();

  service.upsertGatewayAdminDistillSubject({
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    role: 'Architect',
    realPerson: false,
  });
  const paths = resolveDistillPaths('maya', 'maya');
  saveDistillState(paths, {
    version: 1,
    subject: 'maya',
    analysedDocIds: ['doc_abc123abc123'],
    identity: {
      name: 'Maya',
      creature: 'Distilled coworker',
      vibe: 'calm and direct',
      emoji: '',
    },
    userNotes: ['Expects pushback to come with workload numbers.'],
    skillName: 'maya-playbook',
    claims: [
      {
        id: 'claim_1',
        dimension: 'decision-making',
        claim: 'Prefers boring options until measurements demand otherwise.',
        evidence: ['doc_abc123abc123'],
        confidence: 0.9,
        status: 'standing',
        firstSeenRunId: 'dst_test',
        updatedAt: now,
      },
    ],
    mergeHistory: [
      {
        runId: 'dst_test',
        mergedAt: now,
        claimsAdded: 1,
        claimsSuperseded: 0,
        reviewsOpened: 0,
      },
    ],
  });

  service.registerGatewayAdminDistillAgent({ alias: 'maya' });

  const memory = fs.readFileSync(
    path.join(paths.workspaceDir, 'MEMORY.md'),
    'utf-8',
  );
  expect(memory).toContain('Distilled subject: Maya Lindqvist.');
  expect(memory).toContain('Prefers boring options');
  expect(memory).toContain('<!-- doc_abc123abc123 -->');
  expect(memory).toContain('skills/maya-playbook/SKILL.md');
});

test('admin distill service creates a consented subject, uploads a source, and starts a run', async () => {
  const service = await loadService();

  const subject = service.upsertGatewayAdminDistillSubject({
    alias: 'maya',
    displayName: 'Maya Lindqvist',
    matchAliases: ['maya@example.com'],
    realPerson: true,
  });
  expect(subject.alias).toBe('maya');
  expect(subject.consent.valid).toBe(false);

  const consented = service.recordGatewayAdminDistillConsent({
    alias: 'maya',
    grantedBy: 'Maya Lindqvist',
    method: 'written',
    statement: 'I consent to distillation.',
  });
  expect(consented.consent.valid).toBe(true);

  const upload = await service.uploadGatewayAdminDistillSource({
    alias: 'maya',
    filename: '../memo.md',
    kind: 'markdown',
    buffer: Buffer.from(
      '# Decisions\n\nBoring options win until measurements demand otherwise.',
      'utf-8',
    ),
  });
  expect(upload.filename).toBe('memo.md');
  expect(upload.source.kind).toBe('markdown');
  expect(upload.path).toContain(
    path.join(
      tempHome,
      '.hybridclaw',
      'data',
      'agents',
      'maya',
      'workspace',
      'distill',
      'maya',
      'uploads',
    ),
  );

  const result = service.runGatewayAdminDistillPipeline({
    alias: 'maya',
    sources: [upload.source],
    holdoutRatio: 0,
  });

  expect(result.run.status).toBe('awaiting-extraction');
  expect(result.run.stats.documentsAdded).toBe(1);
  expect(result.subject.corpusDocuments).toBe(1);
  expect(result.warnings).toEqual([]);
});
