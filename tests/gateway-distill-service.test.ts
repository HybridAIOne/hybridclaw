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
