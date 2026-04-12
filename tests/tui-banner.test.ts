import { expect, test } from 'vitest';

import { renderTuiStartupBanner } from '../src/tui-banner.js';

const palette = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
  activeSkill: '',
  inactiveSkill: '',
};

function stripAnsi(value: string): string {
  let output = '';
  for (let index = 0; index < value.length; ) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === '[') {
      index += 2;
      while (index < value.length) {
        const code = value.charCodeAt(index);
        index += 1;
        if (code >= 64 && code <= 126) break;
      }
      continue;
    }
    output += value[index] || '';
    index += 1;
  }
  return output;
}

function visibleLength(value: string): number {
  return [...stripAnsi(value)].length;
}

test('keeps the panel aligned with the wordmark right edge on wide terminals', () => {
  const lines = renderTuiStartupBanner({
    columns: 160,
    info: {
      currentModel: 'openai-codex/gpt-5.4',
      defaultModel: 'openai-codex/gpt-5-codex',
      sandboxMode: 'container',
      gatewayBaseUrl: 'http://127.0.0.1:3000',
      hybridAIBaseUrl: 'https://api.hybridai.com',
      chatbotId: 'bot-123',
      version: '0.8.0',
      skillCategories: [
        {
          category: 'Office',
          skills: [
            { name: 'docx', active: true },
            { name: 'pdf', active: false },
            { name: 'xlsx', active: true },
          ],
        },
        {
          category: 'Memory',
          skills: [
            { name: 'notion', active: false },
            { name: 'obsidian', active: true },
          ],
        },
      ],
    },
    palette,
  }).map(stripAnsi);
  const boxTop = lines.find((line) => line.includes('╭')) || '';
  const leftSegmentWidth = visibleLength(boxTop.slice(0, boxTop.indexOf('╭')));
  const boxWidth = visibleLength(boxTop.slice(boxTop.indexOf('╭')));
  const titleWidth = visibleLength(lines.at(-8) || '');
  const spacerIndex = lines.indexOf('');

  expect(lines[0]).toContain('⣀⣠⣤');
  expect(lines[0]).toContain('╭');
  expect(spacerIndex).toBe(26);
  expect(lines[25]).toContain('⠛⠋⠀⠀⠀⠛⠛');
  expect(lines[25]).toContain('╯');
  expect(lines[0]).toContain('◌');
  expect(leftSegmentWidth + boxWidth).toBe(titleWidth);
  expect(lines).toContainEqual(expect.stringContaining('Runtime (v0.8.0)'));
  expect(lines).toContainEqual(
    expect.stringContaining('model     openai-codex/gpt-5.4 (Codex)'),
  );
  expect(lines).toContainEqual(
    expect.stringContaining('gateway   http://127.0.0.1:3000 (container mode)'),
  );
  expect(lines.some((line) => line.includes('provider  '))).toBe(false);
  expect(lines.some((line) => line.includes('sandbox   '))).toBe(false);
  expect(lines.some((line) => line.includes('version   '))).toBe(false);
  expect(lines.some((line) => line.includes('default   '))).toBe(false);
  expect(lines.some((line) => line.includes('hybridai  '))).toBe(false);
  expect(lines).toContainEqual(
    expect.stringContaining(
      'Office: docx, pdf, xlsx - Memory: notion, obsidian',
    ),
  );
  expect(lines).toContainEqual(expect.stringContaining('/channel-policy'));
  expect(lines).toContainEqual(expect.stringContaining('░██     ░██'));
  expect(lines.at(-1)).toContain('Powered by HybridAI  v0.8.0');
});

test('does not stretch the panel wider than the wordmark span on medium terminals', () => {
  const lines = renderTuiStartupBanner({
    columns: 120,
    info: {
      currentModel: 'openai-codex/gpt-5.4',
      defaultModel: 'openai-codex/gpt-5-codex',
      sandboxMode: 'container',
      gatewayBaseUrl: 'http://127.0.0.1:3000',
      hybridAIBaseUrl: 'https://api.hybridai.com',
      chatbotId: 'bot-123',
      version: '0.8.0',
      skillCategories: [
        {
          category: 'Office',
          skills: [
            { name: 'docx', active: true },
            { name: 'pdf', active: false },
            { name: 'xlsx', active: true },
          ],
        },
        {
          category: 'Memory',
          skills: [
            { name: 'notion', active: false },
            { name: 'obsidian', active: true },
          ],
        },
      ],
    },
    palette,
  }).map(stripAnsi);
  const boxTop = lines.find((line) => line.includes('╭')) || '';
  const leftSegmentWidth = visibleLength(boxTop.slice(0, boxTop.indexOf('╭')));
  const boxWidth = visibleLength(boxTop.slice(boxTop.indexOf('╭')));
  const titleWidth = visibleLength(lines.at(-8) || '');

  expect(lines[0]).toContain('⣀⣠⣤');
  expect(lines[0]).toContain('╭');
  expect(leftSegmentWidth + boxWidth).toBe(titleWidth);
  expect(lines).toContainEqual(expect.stringContaining('░██     ░██'));
});

test('falls back to a stacked banner and compact title on narrow terminals', () => {
  const lines = renderTuiStartupBanner({
    columns: 68,
    info: {
      currentModel: 'openrouter/anthropic/claude-sonnet-4',
      defaultModel: 'openai-codex/gpt-5-codex',
      sandboxMode: 'container',
      gatewayBaseUrl: 'http://127.0.0.1:3000',
      hybridAIBaseUrl: 'https://api.hybridai.com',
      chatbotId: 'unset',
      version: '0.8.0',
      skillCategories: [
        {
          category: 'Office',
          skills: [
            { name: 'docx', active: true },
            { name: 'pdf', active: false },
            { name: 'xlsx', active: true },
          ],
        },
        {
          category: 'Memory',
          skills: [
            { name: 'notion', active: false },
            { name: 'obsidian', active: true },
          ],
        },
      ],
    },
    palette,
  }).map(stripAnsi);

  expect(lines[0]).toContain('⣀⣠⣤');
  expect(lines[0]).not.toContain('╭');
  expect(lines.findIndex((line) => line.includes('╭'))).toBeGreaterThan(20);
  expect(lines).toContainEqual(expect.stringContaining('HybridClaw v0.8.0'));
  expect(lines.some((line) => line.includes('░██     ░██'))).toBe(false);
});

test('wraps panel rows for very narrow terminals and defaults provider to HybridAI', () => {
  const lines = renderTuiStartupBanner({
    columns: 32,
    info: {
      currentModel: 'hybridai-default',
      defaultModel: 'hybridai-default',
      sandboxMode: 'host',
      gatewayBaseUrl: 'http://127.0.0.1:3000',
      hybridAIBaseUrl: 'https://api.hybridai.com',
      chatbotId: '',
      version: '0.8.0',
      skillCategories: [
        {
          category: 'Office',
          skills: [
            { name: 'docx', active: true },
            { name: 'pdf', active: false },
            { name: 'xlsx', active: true },
          ],
        },
        {
          category: 'Memory',
          skills: [
            { name: 'notion', active: false },
            { name: 'obsidian', active: true },
          ],
        },
        {
          category: 'Apple',
          skills: [
            { name: 'apple-calendar', active: false },
            { name: 'apple-music', active: true },
          ],
        },
      ],
    },
    palette,
  }).map(stripAnsi);

  expect(lines).toContainEqual(expect.stringContaining('Runtime (v0.8.0)'));
  expect(lines).toContainEqual(
    expect.stringContaining('model     hybridai-default'),
  );
  expect(lines).toContainEqual(expect.stringContaining('(HybridAI)'));
  expect(lines.some((line) => line.includes('provider  '))).toBe(false);
  expect(lines).toContainEqual(
    expect.stringContaining('gateway   http://127.0.0.1'),
  );
  expect(lines).toContainEqual(expect.stringContaining(':3000 (host'));
  expect(lines).toContainEqual(expect.stringContaining('mode)'));
  expect(lines.some((line) => line.includes('sandbox   '))).toBe(false);
  expect(lines.some((line) => line.includes('version   '))).toBe(false);
  expect(lines.some((line) => line.includes('default   '))).toBe(false);
  expect(lines.some((line) => line.includes('hybridai  '))).toBe(false);
  expect(lines).toContainEqual(
    expect.stringContaining('Office: docx, pdf, xlsx'),
  );
  expect(lines).toContainEqual(
    expect.stringContaining('Memory: notion, obsidian'),
  );
  expect(lines).toContainEqual(
    expect.stringContaining('Apple: apple-calendar,'),
  );
  expect(lines).toContainEqual(expect.stringContaining('Apple:'));
  expect(lines).toContainEqual(expect.stringContaining('apple-music'));
  expect(lines.some((line) => line.includes('│ - '))).toBe(false);
  const slashHeaderIndex = lines.indexOf('│ Slash Commands             │');
  const bottomBorderIndex = lines.findIndex(
    (line, index) => index > slashHeaderIndex && line.includes('╰'),
  );
  const slashCommands = lines.slice(slashHeaderIndex + 1, bottomBorderIndex);
  expect(slashCommands).toEqual([
    '│ /agent                     │',
    '│ /approve                   │',
    '│ /audit                     │',
    '│ /auth                      │',
    '│ /bot                       │',
    '│ /channel-mode              │',
    '│ /channel-policy            │',
    '│ /clear                     │',
    '│ /compact                   │',
    '│ /config                    │',
    '│ /dream                     │',
    '│ /exit                      │',
    '│ /export                    │',
    '│ /fullauto                  │',
    '│ /help                      │',
    '│ /info                      │',
    '│ /mcp                       │',
    '│ /model                     │',
    '│ /rag                       │',
    '│ /ralph                     │',
    '│ /reset                     │',
    '│ /schedule                  │',
    '│ /sessions                  │',
    '│ /show                      │',
    '│ /skill                     │',
    '│ /status                    │',
    '│ /stop                      │',
    '│ /usage                     │',
  ]);
});

test('applies the configured monochrome ramp to the large wordmark', () => {
  const lines = renderTuiStartupBanner({
    columns: 160,
    info: {
      currentModel: 'openai-codex/gpt-5.4',
      defaultModel: 'openai-codex/gpt-5-codex',
      sandboxMode: 'container',
      gatewayBaseUrl: 'http://127.0.0.1:3000',
      hybridAIBaseUrl: 'https://api.hybridai.com',
      chatbotId: 'bot-123',
      version: '0.8.0',
      skillCategories: [
        {
          category: 'Office',
          skills: [
            { name: 'docx', active: true },
            { name: 'pdf', active: false },
            { name: 'xlsx', active: true },
          ],
        },
        {
          category: 'Memory',
          skills: [
            { name: 'notion', active: false },
            { name: 'obsidian', active: true },
          ],
        },
      ],
    },
    palette: {
      ...palette,
      reset: '\x1b[0m',
      gold: '\x1b[33m',
      muted: '\x1b[90m',
      teal: '\x1b[36m',
      activeSkill: '\x1b[97m',
      inactiveSkill: '\x1b[90m',
      wordmarkRamp: [
        '\x1b[31m',
        '\x1b[32m',
        '\x1b[33m',
        '\x1b[34m',
        '\x1b[35m',
        '\x1b[36m',
        '\x1b[37m',
      ],
    },
  });
  const titleLines = lines.slice(-8, -1);

  expect(titleLines[0]).toContain('\x1b[31m');
  expect(titleLines[3]).toContain('\x1b[34m');
  expect(titleLines[6]).toContain('\x1b[37m');
  expect(lines.some((line) => line.includes('\x1b[33mOffice:\x1b[0m'))).toBe(
    true,
  );
  expect(lines.some((line) => line.includes('\x1b[97mdocx,\x1b[0m'))).toBe(
    true,
  );
  expect(lines.some((line) => line.includes('\x1b[90mpdf,\x1b[0m'))).toBe(true);
  expect(lines.at(-1)).toContain('\x1b[90mPowered by HybridAI');
});
