import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { openPdfDocument } from '../skills/pdf/scripts/_pdf_runtime.mjs';
import { useTempDir } from './test-utils.js';

const makeTempDir = useTempDir('pdf-unicode-');
const script = path.resolve('skills/pdf/scripts/create_pdf.mjs');

function createPdf(output: string, args: string[]) {
  return spawnSync(process.execPath, [script, output, ...args], {
    encoding: 'utf8',
    cwd: path.dirname(output),
  });
}

async function extractText(output: string) {
  const pdf = await openPdfDocument(output);
  const pages: string[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const page = await pdf.getPage(number);
    const content = await page.getTextContent();
    pages.push(
      content.items.map((item) => ('str' in item ? item.str : '')).join(' '),
    );
  }
  return pages.join(' ');
}

describe('PDF creation font coverage', () => {
  test('preserves every Cyrillic letter alongside Latin text over multiple pages', async () => {
    const output = path.join(makeTempDir(), 'alphabet.pdf');
    const uppercase = 'АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ';
    const rows = [...uppercase].map(
      (letter, index) => `${letter} ${letter.toLowerCase()} — Latin ${index}`,
    );
    const result = createPdf(output, [
      '--title',
      'Русский алфавит',
      '--text',
      rows.join('\\n'),
    ]);
    expect(result.status, result.stderr).toBe(0);
    const text = await extractText(output);
    expect(text).toContain('Русский алфавит');
    for (const row of rows) expect(text).toContain(row);
  });

  test.each([
    ['--title', 'Ελληνικά'],
    ['--text', 'Ελληνικά'],
  ])(
    'automatically embeds Unicode for %s independently',
    async (flag, value) => {
      const output = path.join(makeTempDir(), 'greek.pdf');
      const result = createPdf(output, ['--text', 'Latin äöü', flag, value]);
      expect(result.status, result.stderr).toBe(0);
      expect(await extractText(output)).toContain(value);
    },
  );

  test('accepts a local font path for both title and body', async () => {
    const output = path.join(makeTempDir(), 'custom.pdf');
    const font = new URL(
      import.meta.resolve(
        'pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf',
      ),
    );
    const result = createPdf(output, [
      '--title',
      'Ёж',
      '--text',
      'Ж ж — Zh',
      '--font-path',
      font.pathname,
    ]);
    expect(result.status, result.stderr).toBe(0);
    const text = await extractText(output);
    expect(text).toContain('Ёж');
    expect(text).toContain('Ж ж — Zh');
  });

  test.each(['--title', '--text'])(
    'rejects missing glyphs in %s without overwriting output',
    (flag) => {
      const output = path.join(makeTempDir(), 'existing.pdf');
      fs.writeFileSync(output, 'existing deliverable');
      const result = createPdf(output, [flag, '中']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('U+4E2D');
      expect(result.stderr).toContain('--font-path');
      expect(fs.readFileSync(output, 'utf8')).toBe('existing deliverable');
    },
  );

  test('rejects a missing font path argument without creating output', () => {
    const output = path.join(makeTempDir(), 'missing.pdf');
    const result = createPdf(output, ['--text', 'А', '--font-path']);
    expect(result.status).toBe(1);
    expect(fs.existsSync(output)).toBe(false);
  });
});
