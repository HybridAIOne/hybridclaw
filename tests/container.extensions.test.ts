import { afterEach, describe, expect, test, vi } from 'vitest';

describe('container runtime extensions', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  test('blocks write tool for binary office and pdf targets', async () => {
    const { runBeforeToolHooks } = await import('../container/src/extensions.js');

    await expect(
      runBeforeToolHooks(
        'write',
        JSON.stringify({
          path: 'fake-sales-data.xlsx',
          contents: 'Created fake-sales-data.xlsx with 10 rows...',
        }),
      ),
    ).resolves.toContain('Refusing to write plain text into binary Office/PDF file');

    await expect(
      runBeforeToolHooks(
        'write',
        JSON.stringify({
          path: 'proposal.docx',
          contents: '# Quarterly proposal',
        }),
      ),
    ).resolves.toContain('proposal.docx');

    await expect(
      runBeforeToolHooks(
        'write',
        JSON.stringify({
          path: 'deck.pptx',
          contents: 'Slide 1',
        }),
      ),
    ).resolves.toContain('deck.pptx');

    await expect(
      runBeforeToolHooks(
        'write',
        JSON.stringify({
          path: 'report.pdf',
          contents: 'PDF placeholder',
        }),
      ),
    ).resolves.toContain('report.pdf');
  });

  test('blocks edit tool for binary office and pdf targets', async () => {
    const { runBeforeToolHooks } = await import('../container/src/extensions.js');

    await expect(
      runBeforeToolHooks(
        'edit',
        JSON.stringify({
          path: 'fake-sales-data.xlsx',
          old: 'old',
          new: 'new',
        }),
      ),
    ).resolves.toContain('Refusing to edit plain text into binary Office/PDF file');
  });

  test('does not block normal text file writes', async () => {
    const { runBeforeToolHooks } = await import('../container/src/extensions.js');

    await expect(
      runBeforeToolHooks(
        'write',
        JSON.stringify({
          path: 'scripts/create_sales_workbook.cjs',
          contents: "const ExcelJS = require('exceljs');",
        }),
      ),
    ).resolves.toBeNull();
  });
});
