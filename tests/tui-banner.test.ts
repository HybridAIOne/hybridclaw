import { expect, test } from 'vitest';

import { renderTuiStartupBanner } from '../src/tui-banner.js';

const palette = {
  reset: '',
  bold: '',
  muted: '',
  teal: '',
  gold: '',
  green: '',
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
    },
    palette,
  }).map(stripAnsi);
  const boxTop = lines.find((line) => line.includes('╭')) || '';
  const leftSegmentWidth = visibleLength(boxTop.slice(0, boxTop.indexOf('╭')));
  const boxWidth = visibleLength(boxTop.slice(boxTop.indexOf('╭')));
  const titleWidth = visibleLength(lines.at(-8) || '');

  expect(lines[0]).toContain('⣀⣠⣤');
  expect(lines[0]).toContain('╭');
  expect(lines.indexOf('')).toBe(26);
  expect(lines[25]).toContain('⠛⠋⠀⠀⠀⠛⠛');
  expect(lines[25]).toContain('╯');
  expect(lines[0]).toContain('◌');
  expect(leftSegmentWidth + boxWidth).toBe(titleWidth);
  expect(lines).toContainEqual(expect.stringContaining('provider  Codex'));
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
    },
    palette,
  }).map(stripAnsi);

  expect(lines).toContainEqual(expect.stringContaining('provider  HybridAI'));
  expect(lines).toContainEqual(expect.stringContaining('TAB  accept slash'));
  expect(lines).toContainEqual(expect.stringContaining('suggestion'));
  expect(lines).toContainEqual(expect.stringContaining('ESC  close menu or'));
  expect(lines).toContainEqual(expect.stringContaining('interrupt run'));
  const slashHeaderIndex = lines.indexOf('│ Slash Commands             │');
  const bottomBorderIndex = lines.findIndex(
    (line, index) => index > slashHeaderIndex && line.includes('╰'),
  );
  const slashCommands = lines.slice(slashHeaderIndex + 1, bottomBorderIndex);
  expect(slashCommands).toEqual([
    '│ /agent                     │',
    '│ /approve                   │',
    '│ /audit                     │',
    '│ /bot                       │',
    '│ /channel-mode              │',
    '│ /channel-policy            │',
    '│ /clear                     │',
    '│ /compact                   │',
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
    },
    palette: {
      ...palette,
      reset: '\x1b[0m',
      gold: '\x1b[33m',
      muted: '\x1b[90m',
      teal: '\x1b[36m',
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
  expect(lines.at(-1)).toContain('\x1b[90mPowered by HybridAI');
});
