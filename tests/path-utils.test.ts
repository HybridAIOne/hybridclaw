import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import { expandHomePath } from '../src/utils/path.ts';

test('expands home-prefixed paths with slash and backslash separators', () => {
  expect(expandHomePath('~/workspace')).toBe(
    path.join(os.homedir(), 'workspace'),
  );
  expect(expandHomePath('~\\workspace')).toBe(
    path.join(os.homedir(), 'workspace'),
  );
});

test('trims path input and leaves non-home paths unchanged', () => {
  expect(expandHomePath('  ~  ')).toBe(os.homedir());
  expect(expandHomePath('  ./relative/path  ')).toBe('./relative/path');
});
