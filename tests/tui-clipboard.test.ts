import { expect, test } from 'vitest';

import {
  convertWindowsPathToWsl,
  parseClipboardPayload,
  parseClipboardUriList,
} from '../src/tui-clipboard.js';

test('parseClipboardPayload prefers file-path payloads', () => {
  expect(
    parseClipboardPayload(
      JSON.stringify({
        filePaths: ['/tmp/a.png', '/tmp/a.png', '/tmp/report.pdf'],
        imageBase64: 'ignored',
        mimeType: 'image/png',
        filename: 'clipboard.png',
      }),
    ),
  ).toEqual({
    filePaths: ['/tmp/a.png', '/tmp/report.pdf'],
    imageBase64: 'ignored',
    mimeType: 'image/png',
    filename: 'clipboard.png',
  });
});

test('parseClipboardPayload returns null for empty clipboard payloads', () => {
  expect(
    parseClipboardPayload(
      JSON.stringify({
        filePaths: [],
        imageBase64: '',
      }),
    ),
  ).toBeNull();
});

test('parseClipboardUriList accepts file urls, quoted paths, and deduplicates', () => {
  expect(
    parseClipboardUriList(
      [
        '# comment',
        'file:///tmp/example.png',
        '"/tmp/example.png"',
        '/tmp/report.pdf',
        '/tmp/report.pdf',
      ].join('\n'),
    ),
  ).toEqual(['/tmp/example.png', '/tmp/report.pdf']);
});

test('convertWindowsPathToWsl maps drive and UNC WSL paths', () => {
  expect(convertWindowsPathToWsl('C:\\Users\\bkoehler\\image.png')).toBe(
    '/mnt/c/Users/bkoehler/image.png',
  );
  expect(
    convertWindowsPathToWsl(
      '\\\\wsl$\\Ubuntu\\home\\bkoehler\\project\\image.png',
    ),
  ).toBe('/home/bkoehler/project/image.png');
  expect(convertWindowsPathToWsl('not-a-path')).toBeNull();
});

test('parseClipboardPayload can remap file paths for WSL', () => {
  expect(
    parseClipboardPayload(
      JSON.stringify({
        filePaths: ['C:\\Users\\bkoehler\\image.png'],
        imageBase64: null,
        mimeType: null,
        filename: null,
      }),
      {
        mapFilePath: convertWindowsPathToWsl,
      },
    ),
  ).toEqual({
    filePaths: ['/mnt/c/Users/bkoehler/image.png'],
    imageBase64: null,
    mimeType: null,
    filename: null,
  });
});
