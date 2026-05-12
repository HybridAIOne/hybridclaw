import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, expect, test, vi } from 'vitest';

let tempRoot = '';
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_MASTER_KEY = process.env.HYBRIDCLAW_MASTER_KEY;
const ORIGINAL_DATEV_PASSWORD = process.env.DATEV_PASSWORD;

function makeTempRoot(): string {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-browser-fill-'));
  return tempRoot;
}

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function writeSecretPolicy(root: string, content: string): void {
  const workspacePath = path.join(root, 'workspace');
  fs.mkdirSync(path.join(workspacePath, '.hybridclaw'), { recursive: true });
  fs.writeFileSync(
    path.join(workspacePath, '.hybridclaw', 'policy.yaml'),
    content,
    'utf-8',
  );
}

function createPage() {
  const locator = {
    fill: vi.fn(async () => undefined),
    pressSequentially: vi.fn(async () => undefined),
  };
  return {
    page: {
      fill: vi.fn(async () => undefined),
      locator: vi.fn(() => locator),
      url: vi.fn(() => 'https://login.datev.de/login'),
    },
    locator,
  };
}

function createPageWithBrokenUrl() {
  const locator = {
    fill: vi.fn(async () => undefined),
    pressSequentially: vi.fn(async () => undefined),
  };
  return {
    page: {
      fill: vi.fn(async () => undefined),
      locator: vi.fn(() => locator),
      url: vi.fn(() => {
        throw new Error('no page URL');
      }),
    },
    locator,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
    tempRoot = '';
  }
  restoreEnvVar('HOME', ORIGINAL_HOME);
  restoreEnvVar('HYBRIDCLAW_MASTER_KEY', ORIGINAL_MASTER_KEY);
  restoreEnvVar('DATEV_PASSWORD', ORIGINAL_DATEV_PASSWORD);
});

test('browser credential fill enforces skill host selector policy and emits metadata-only audit', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-fill-test-master-key';
  process.env.DATEV_PASSWORD = 'datev-cleartext-secret';
  writeSecretPolicy(
    root,
    [
      'secret:',
      '  default: deny',
      '  rules:',
      '    - id: allow-datev-password-fill',
      '      action: allow',
      '      when:',
      '        predicate: secret_resolve_allowed',
      '        source: env',
      '        id: DATEV_PASSWORD',
      '        sink: dom',
      '        skill: invoice-harvester',
      '        host: "*.datev.de"',
      '        selector: "#password"',
      '',
    ].join('\n'),
  );
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: () => path.join(root, 'workspace'),
  }));

  const { initDatabase, getRecentStructuredAuditForSession } = await import(
    '../src/memory/db.js'
  );
  const { fillBrowserField } = await import(
    '../src/browser/playwright-utils.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'audit.db') });
  const { page, locator } = createPage();

  await fillBrowserField(
    page,
    '#password',
    { source: 'env', id: 'DATEV_PASSWORD' },
    undefined,
    {
      sessionId: 'session-datev-fill',
      agentId: 'agent-datev',
      skillName: 'invoice-harvester',
      auditRunId: 'run-datev-fill',
    },
  );

  expect(page.fill).not.toHaveBeenCalled();
  expect(page.locator).toHaveBeenCalledWith('#password');
  expect(locator.fill).toHaveBeenCalledWith('');
  expect(locator.pressSequentially).toHaveBeenCalledWith(
    'datev-cleartext-secret',
  );

  const events = getRecentStructuredAuditForSession('session-datev-fill', 10);
  const payloads = events.map((entry) => JSON.parse(entry.payload));
  expect(payloads).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: 'secret.resolved',
        skill: 'invoice-harvester',
        secretRef: { source: 'env', id: 'DATEV_PASSWORD' },
        sinkKind: 'dom',
        host: 'login.datev.de',
        selector: '#password',
      }),
      expect.objectContaining({
        type: 'browser.credential_filled',
        skill: 'invoice-harvester',
        secretRef: { source: 'env', id: 'DATEV_PASSWORD' },
        host: 'login.datev.de',
        selector: '#password',
      }),
    ]),
  );
  expect(JSON.stringify(payloads)).not.toContain('datev-cleartext-secret');
});

test('browser credential fill blocks SecretRefs outside the skill policy predicate', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-fill-test-master-key';
  process.env.DATEV_PASSWORD = 'datev-cleartext-secret';
  writeSecretPolicy(
    root,
    [
      'secret:',
      '  default: deny',
      '  rules:',
      '    - action: allow',
      '      when:',
      '        predicate: secret_resolve_allowed',
      '        source: env',
      '        id: DATEV_PASSWORD',
      '        sink: dom',
      '        skill: invoice-harvester',
      '        host: "*.datev.de"',
      '        selector: "#password"',
      '',
    ].join('\n'),
  );
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: () => path.join(root, 'workspace'),
  }));

  const { initDatabase } = await import('../src/memory/db.js');
  const { fillBrowserField } = await import(
    '../src/browser/playwright-utils.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'audit.db') });
  const { page } = createPage();

  await expect(
    fillBrowserField(
      page,
      '#totp',
      { source: 'env', id: 'DATEV_PASSWORD' },
      undefined,
      {
        sessionId: 'session-datev-blocked',
        agentId: 'agent-datev',
        skillName: 'invoice-harvester',
        auditRunId: 'run-datev-blocked',
      },
    ),
  ).rejects.toThrow(/blocked by secret resolution policy/u);

  expect(page.locator).not.toHaveBeenCalled();
});

test('browser credential fill fails closed when page host cannot be resolved', async () => {
  const root = makeTempRoot();
  process.env.HOME = root;
  process.env.HYBRIDCLAW_MASTER_KEY = 'browser-fill-test-master-key';
  process.env.DATEV_PASSWORD = 'datev-cleartext-secret';
  writeSecretPolicy(
    root,
    [
      'secret:',
      '  default: deny',
      '  rules:',
      '    - action: allow',
      '      when:',
      '        predicate: secret_resolve_allowed',
      '        source: env',
      '        id: DATEV_PASSWORD',
      '        sink: dom',
      '        skill: invoice-harvester',
      '',
    ].join('\n'),
  );
  vi.doMock('../src/infra/ipc.js', () => ({
    agentWorkspaceDir: () => path.join(root, 'workspace'),
  }));

  const { initDatabase } = await import('../src/memory/db.js');
  const { fillBrowserField } = await import(
    '../src/browser/playwright-utils.js'
  );
  initDatabase({ quiet: true, dbPath: path.join(root, 'audit.db') });
  const { page } = createPageWithBrokenUrl();

  await expect(
    fillBrowserField(
      page,
      '#password',
      { source: 'env', id: 'DATEV_PASSWORD' },
      undefined,
      {
        sessionId: 'session-datev-no-host',
        agentId: 'agent-datev',
        skillName: 'invoice-harvester',
        auditRunId: 'run-datev-no-host',
      },
    ),
  ).rejects.toThrow(/requires a resolvable page URL/u);

  expect(page.locator).not.toHaveBeenCalled();
});
