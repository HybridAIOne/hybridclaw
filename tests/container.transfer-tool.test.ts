import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

describe.sequential('container draft_transfer tool', () => {
  let workspaceRoot = '';

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (workspaceRoot) {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
      workspaceRoot = '';
    }
  });

  async function tools() {
    workspaceRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'hybridclaw-transfer-workspace-'),
    );
    vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', workspaceRoot);
    return await import('../container/src/tools.js');
  }

  test('writes the transfer under transfers/ and returns it with the transfer media type', async () => {
    const { executeToolWithMetadata, TOOL_DEFINITIONS } = await tools();

    const result = await executeToolWithMetadata(
      'draft_transfer',
      JSON.stringify({
        name: 'Müller  Gärten GmbH',
        iban: 'de89 3704 0044 0532 0130 00',
        bic: 'cobadeffxxx',
        amount: 37.2,
        reference: 'RG-Nr. 8117 6000 0023',
      }),
    );
    const parsed = JSON.parse(result.output) as {
      success: boolean;
      path: string;
      artifacts: Array<{ path: string; filename: string; mimeType: string }>;
    };

    expect(result.isError).toBe(false);
    expect(parsed.path).toMatch(
      /^transfers\/muller-garten-gmbh-[0-9a-f]{8}\.json$/,
    );
    expect(parsed.artifacts).toEqual([
      {
        path: parsed.path,
        filename: 'Müller Gärten GmbH.json',
        mimeType: 'application/vnd.hybridai.transfer+json',
      },
    ]);
    expect(
      JSON.parse(fs.readFileSync(path.join(workspaceRoot, parsed.path), 'utf-8')),
    ).toEqual({
      name: 'Müller Gärten GmbH',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      amount: '37.20',
      currency: 'EUR',
      reference: 'RG-Nr. 8117 6000 0023',
    });
    expect(TOOL_DEFINITIONS.map((tool) => tool.function.name)).toContain(
      'draft_transfer',
    );
  });

  test('refuses an IBAN whose check digits do not match, and other bad details', async () => {
    const { executeToolWithMetadata } = await tools();
    const call = (args: Record<string, unknown>) =>
      executeToolWithMetadata('draft_transfer', JSON.stringify(args));

    const typo = await call({ name: 'A', iban: 'DE89370400440532013001' });
    expect(typo.isError).toBe(true);
    expect(typo.output).toContain('not a valid IBAN');
    expect(
      (await call({ iban: 'DE89370400440532013000' })).isError,
    ).toBe(true);
    expect(
      (
        await call({
          name: 'A',
          iban: 'DE89370400440532013000',
          amount: 12.345,
        })
      ).isError,
    ).toBe(true);
    expect(
      (
        await call({
          name: 'A',
          iban: 'DE89370400440532013000',
          currency: 'CHF',
        })
      ).isError,
    ).toBe(true);
    expect(fs.existsSync(path.join(workspaceRoot, 'transfers'))).toBe(false);
  });

  test('an amount may be left for the user, and a changed transfer gets its own file', async () => {
    const { normalizeTransfer, transferFilePath } = await import(
      '../container/src/tools/transfer.js'
    );
    const open = normalizeTransfer({
      name: 'Tafel e.V.',
      iban: 'DE89370400440532013000',
    });
    expect(open).toEqual({
      name: 'Tafel e.V.',
      iban: 'DE89370400440532013000',
      currency: 'EUR',
    });
    expect(transferFilePath(open)).not.toBe(
      transferFilePath({ ...open, amount: '10.00' }),
    );
  });
});
