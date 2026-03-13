import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterEach, describe, expect, test } from 'vitest';

import { setSandboxModeOverride } from '../src/config/config.js';
import {
  clampText,
  injectPdfContextMessages,
} from '../src/media/pdf-context.js';
import type { ChatMessage } from '../src/types.js';

async function createPdf(filePath: string, text: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText(text, {
    x: 40,
    y: 340,
    size: 18,
    font,
  });
  await fs.writeFile(filePath, await pdf.save());
}

function latestSystemMessage(messages: ChatMessage[]): ChatMessage | undefined {
  return [...messages].reverse().find((message) => message.role === 'system');
}

describe('injectPdfContextMessages', () => {
  afterEach(() => {
    setSandboxModeOverride(null);
  });

  test('clampText respects small caps including the truncation suffix', () => {
    const clamped = clampText('x'.repeat(2_000), 80);

    expect(clamped.length).toBeLessThanOrEqual(80);
    expect(clamped.endsWith('...[truncated]')).toBe(true);
  });

  test('clampText does not exceed tiny caps', () => {
    const clamped = clampText('x'.repeat(2_000), 10);

    expect(clamped).toHaveLength(10);
  });

  test('injects current-turn PDF text for an explicit local file path', async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hybridclaw-pdf-context-'),
    );
    const pdfPath = path.join(workspaceRoot, 'invoice.pdf');
    await createPdf(pdfPath, 'Invoice Number 5868229');

    const messages = await injectPdfContextMessages({
      sessionId: 'session-explicit-path',
      workspaceRoot,
      messages: [
        {
          role: 'user',
          content: 'Please summarize "./invoice.pdf".',
        },
      ],
    });

    expect(messages).toHaveLength(2);
    const systemMessage = latestSystemMessage(messages);
    expect(systemMessage?.content).toContain('[PDFContext]');
    expect(systemMessage?.content).toContain(
      '<file name="invoice.pdf" mime="application/pdf">',
    );
    expect(systemMessage?.content).toContain('Invoice Number 5868229');
    expect(messages.at(-1)?.content).toBe('Please summarize "./invoice.pdf".');
  });

  test('reuses cached PDF context for approval replay turns', async () => {
    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hybridclaw-pdf-approval-'),
    );
    const pdfPath = path.join(workspaceRoot, 'receipt.pdf');
    await createPdf(pdfPath, 'Approved invoice summary');

    await injectPdfContextMessages({
      sessionId: 'session-approval-replay',
      workspaceRoot,
      messages: [
        {
          role: 'user',
          content: 'Extract the fields from "./receipt.pdf".',
        },
      ],
    });

    const replayMessages = await injectPdfContextMessages({
      sessionId: 'session-approval-replay',
      workspaceRoot,
      messages: [
        {
          role: 'user',
          content: 'yes',
        },
      ],
    });

    expect(replayMessages).toHaveLength(2);
    expect(latestSystemMessage(replayMessages)?.content).toContain(
      'Approved invoice summary',
    );
  });

  test('allows explicit absolute PDF paths in host mode', async () => {
    setSandboxModeOverride('host');

    const workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hybridclaw-pdf-host-mode-'),
    );
    const externalRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'hybridclaw-pdf-external-'),
    );
    const pdfPath = path.join(externalRoot, 'outside-workspace.pdf');
    await createPdf(pdfPath, 'Host mode absolute path');

    const messages = await injectPdfContextMessages({
      sessionId: 'session-host-absolute',
      workspaceRoot,
      messages: [
        {
          role: 'user',
          content: `Please extract "${pdfPath}".`,
        },
      ],
    });

    expect(messages).toHaveLength(2);
    expect(latestSystemMessage(messages)?.content).toContain(
      'Host mode absolute path',
    );
  });
});
