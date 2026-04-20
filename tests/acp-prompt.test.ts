import { expect, test } from 'vitest';

import {
  buildAcpAvailableCommands,
  convertAcpPromptBlocks,
} from '../src/acp/prompt.js';

test('convertAcpPromptBlocks lifts inline images and embedded text resources', () => {
  const prompt = convertAcpPromptBlocks([
    {
      type: 'text',
      text: 'Inspect the current workspace.',
    },
    {
      type: 'image',
      mimeType: 'image/png',
      data: 'aGVsbG8=',
      uri: 'file:///tmp/screenshot.png',
    },
    {
      type: 'resource',
      resource: {
        uri: 'file:///tmp/README.md',
        text: '# README',
        mimeType: 'text/markdown',
      },
    },
    {
      type: 'resource_link',
      name: 'package.json',
      uri: 'file:///tmp/package.json',
      mimeType: 'application/json',
    },
  ]);

  expect(prompt.content).toContain('Inspect the current workspace.');
  expect(prompt.content).toContain(
    '[Embedded resource: file:///tmp/README.md]',
  );
  expect(prompt.content).toContain('# README');
  expect(prompt.content).toContain(
    '[Resource: package.json (file:///tmp/package.json)]',
  );
  expect(prompt.media).toEqual([
    expect.objectContaining({
      filename: 'screenshot.png',
      mimeType: 'image/png',
      url: expect.stringMatching(/^data:image\/png;base64,/),
      originalUrl: 'file:///tmp/screenshot.png',
    }),
  ]);
});

test('buildAcpAvailableCommands exposes local slash commands and excludes tui-only ones', () => {
  const commands = buildAcpAvailableCommands();

  expect(commands).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: 'mcp' }),
      expect.objectContaining({ name: 'model' }),
      expect.objectContaining({ name: 'status' }),
      expect.objectContaining({ name: 'auth' }),
    ]),
  );
  expect(commands.some((command) => command.name === 'paste')).toBe(false);
  expect(commands.some((command) => command.name === 'exit')).toBe(false);
});
