import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONSOLE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = path.join(CONSOLE_ROOT, 'src');
const LEGACY_ACTION_CLASS = /\b(?:primary|secondary|ghost|danger)-button\b/u;

function sourceFiles(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(absolute);
    return /\.(?:css|ts|tsx)$/u.test(entry.name) ? [absolute] : [];
  });
}

describe('console design-system contract', () => {
  it('uses the shared Button variants instead of legacy global action classes', () => {
    const violations = sourceFiles(SRC_ROOT).flatMap((file) => {
      const source = fs.readFileSync(file, 'utf8');
      return LEGACY_ACTION_CLASS.test(source)
        ? [path.relative(SRC_ROOT, file)]
        : [];
    });

    expect(violations).toEqual([]);
  });

  it('keeps the semantic light and dark token sets together', () => {
    const theme = fs.readFileSync(path.join(SRC_ROOT, 'theme.css'), 'utf8');
    expect(theme).toContain(':root {');
    expect(theme).toContain('html[data-theme="light"]');
    expect(theme).toContain('html[data-theme="dark"]');
    for (const token of [
      '--background',
      '--foreground',
      '--card',
      '--primary',
      '--success',
      '--danger',
      '--control-height',
      '--radius-sm',
    ]) {
      expect(theme).toContain(`${token}:`);
    }
  });
});
