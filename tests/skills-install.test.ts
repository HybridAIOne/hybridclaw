import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

describe('skill install metadata', () => {
  const originalHome = process.env.HOME;
  const originalDisableWatcher = process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;

  beforeEach(() => {
    const tempHome = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-skills-install-'),
    );
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('HYBRIDCLAW_DISABLE_CONFIG_WATCHER', '1');
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalDisableWatcher === undefined) {
      delete process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER;
    } else {
      process.env.HYBRIDCLAW_DISABLE_CONFIG_WATCHER = originalDisableWatcher;
    }
  });

  test('loads install metadata declared by the pdf skill', async () => {
    const { findSkillCatalogEntry } = await import(
      '../src/skills/skills-install.ts'
    );
    const skill = findSkillCatalogEntry('pdf');
    expect(skill).not.toBeNull();
    expect(skill?.metadata.hybridclaw.install).toEqual([
      {
        id: 'brew-poppler',
        kind: 'brew',
        formula: 'poppler',
        bins: ['pdftotext', 'pdftoppm', 'pdfinfo', 'pdfimages'],
        label: 'Install Poppler CLI tools (brew)',
      },
      {
        id: 'brew-qpdf',
        kind: 'brew',
        formula: 'qpdf',
        bins: ['qpdf'],
        label: 'Install qpdf (brew)',
      },
    ]);
  });

  test('resolves a declared install option by id', async () => {
    const { resolveSkillInstallSelection } = await import(
      '../src/skills/skills-install.ts'
    );
    const selection = resolveSkillInstallSelection({
      skillName: 'pdf',
      installId: 'brew-poppler',
    });

    if ('error' in selection) {
      throw new Error(selection.error);
    }

    expect(selection.installId).toBe('brew-poppler');
    expect(selection.spec.kind).toBe('brew');
    expect(selection.spec.formula).toBe('poppler');
  });
});
