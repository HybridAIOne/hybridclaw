import { expect, test } from 'vitest';

import {
  formatTuiMarkdownOutput,
  formatTuiSkillListLines,
  formatTuiTitledCommandBlock,
  formatTuiToolActivityBlock,
  formatTuiToolActivityLine,
  isMutedSkillListLine,
  isPluginListHeaderLine,
  nextActiveDelegateToolCount,
  parseTuiSectionCards,
  renderTuiEvalResultsPanel,
  visibleTuiLength,
} from '../src/tui.ts';

function stripAnsi(value: string): string {
  return value.replace(
    new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g'),
    '',
  );
}

test('formats titled command blocks with the standard left gutter', () => {
  expect(
    formatTuiTitledCommandBlock(
      'Plugin Check',
      ['Plugin: demo-plugin', 'Directory: /tmp/demo-plugin'].join('\n'),
      80,
    ),
  ).toEqual([
    '  Plugin Check',
    '',
    '  Plugin: demo-plugin',
    '  Directory: /tmp/demo-plugin',
  ]);
});

test('mutes disabled skill and install hint lines in the skill list', () => {
  expect(isMutedSkillListLine('  apple-music [disabled]')).toBe(true);
  expect(isMutedSkillListLine('      ↳ installs: brew (brew)')).toBe(true);
  expect(isMutedSkillListLine('      installs: brew (brew)')).toBe(true);
  expect(isMutedSkillListLine('  apple-music [enabled]')).toBe(false);
  expect(isMutedSkillListLine('Apple:')).toBe(false);
});

test('keeps wrapped skill install lines muted and aligned', () => {
  const lines = formatTuiSkillListLines(
    [
      'Publishing:',
      '    ↳ installs: manim (uv) — Install Manim Community Edition with uv; ffmpeg (brew) — Install ffmpeg (brew)',
    ].join('\n'),
    78,
  );
  const installLines = lines.slice(1);

  expect(installLines.length).toBeGreaterThan(1);
  expect(installLines.every((line) => line.muted)).toBe(true);
  expect(installLines.map((line) => stripAnsi(line.line))).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^ {6}↳ installs:/u),
      expect.stringMatching(/^ {6}.*ffmpeg \(brew\)/u),
    ]),
  );
});

test('identifies only plugin list section headers for accent color', () => {
  expect(isPluginListHeaderLine('  Plugins')).toBe(true);
  expect(isPluginListHeaderLine('  Installed')).toBe(true);
  expect(isPluginListHeaderLine('  Available')).toBe(true);
  expect(isPluginListHeaderLine('  concierge-router v0.1.0 [home]')).toBe(
    false,
  );
  expect(isPluginListHeaderLine('    name: Concierge Router')).toBe(false);
});

test('tool activity line preserves emoji and leaves room for terminal repaint', () => {
  const line = formatTuiToolActivityLine({
    toolName: 'bash',
    preview:
      "run shell command `node -e \"try{require('google-auth-library'); console.log('ok')}\"`",
    columns: 40,
    frameIndex: 0,
  });
  const plain = stripAnsi(line);

  expect(plain).toContain('🪼');
  expect(plain).not.toContain('�');
  expect(visibleTuiLength(line)).toBeLessThanOrEqual(39);
});

test('tool activity width uses production wide and zero-width handling', () => {
  const line = formatTuiToolActivityLine({
    toolName: 'bash',
    preview: 'run shell command `printf "界é"`',
    columns: 28,
    frameIndex: 0,
  });

  expect(visibleTuiLength(line)).toBeLessThanOrEqual(27);
  expect(stripAnsi(line)).not.toContain('�');
});

test('tool activity block keeps active tools on separate rows', () => {
  const lines = formatTuiToolActivityBlock({
    entries: [
      {
        name: 'read',
        preview: '{"path":"skills/download-platform-invoices/helpers/money"}',
        count: 1,
      },
      { name: 'grep', preview: '{"pattern":"invoice"}', count: 2 },
    ],
    columns: 70,
    frameIndex: 0,
  }).map(stripAnsi);

  expect(lines).toHaveLength(2);
  expect(lines[0]).toContain('read');
  expect(lines[0]).toContain('skills/download-platform-invoices');
  expect(lines[1]).toContain('grep');
  expect(lines[1]).toContain('x2');
});

test('reflows locomo variant tables to the live tui width without splitting rows', () => {
  const text = [
    '┌─ Variants So Far ─────────┐',
    '│ Variant                       HitRate  F1       C1       C2       C3       C4       C5      │',
    '│ --------------------------  -------  -------  -------  -------  -------  -------  ------- │',
    '│ cosine                       0.5560   0.0020   0.3160   0.6240   0.3450   0.6490   0.5280  │',
    '│ \x1b[30;103mcosine + porter + bm25    \x1b[0m  \x1b[30;103m0.8050*\x1b[0m  \x1b[93m0.0020 \x1b[0m  \x1b[30;103m0.5920*\x1b[0m  \x1b[30;103m0.8860*\x1b[0m  \x1b[93m0.4340 \x1b[0m  \x1b[30;103m0.8630*\x1b[0m  \x1b[30;103m0.8640*\x1b[0m │',
    '└────────────────────────────┘',
  ].join('\n');

  const rendered = renderTuiEvalResultsPanel(parseTuiSectionCards(text), 96);
  const joined = rendered.join('\n');
  const dataLine = rendered.find(
    (line) =>
      line.includes('cosine + porter + bm25') &&
      line.includes('0.8630*') &&
      line.includes('0.8640*'),
  );

  expect(joined).toContain('Variants So Far');
  expect(joined).toContain('cosine + porter + bm25');
  expect(joined).toContain('0.8630*');
  expect(joined).toContain('0.8640*');
  expect(dataLine).toBeTruthy();
});

test('renders markdown tables as wrapped terminal tables', () => {
  const text = [
    '| Element | Why It Works | Mental Model |',
    '|---------|-------------|--------------|',
    '| "Make the agent boring enough to trust" (Implicator.ai) | Perfect emotional resonance for the target audience | **Authority + Unity** — external validation speaking the customer language |',
    '| TÜV comparison (Synthszr) | Instantly communicates trust/safety to German audience | **Anchoring** — anchors the product to a known trust standard |',
  ].join('\n');

  const rendered = formatTuiMarkdownOutput(text, 82);
  const plainLines = rendered.split('\n').map(stripAnsi);
  const plain = plainLines.join('\n');

  expect(plain).toContain('╭');
  expect(plain).toContain('Element');
  expect(plain).toContain('Why It Works');
  expect(plain).toContain('Mental Model');
  expect(plain).toContain('Authority + Unity');
  expect(plain).not.toContain('|---------|');
  expect(plain).not.toContain('**Authority + Unity**');
  expect(plainLines.every((line) => visibleTuiLength(line) <= 82)).toBe(true);
});

test('formats inline markdown emphasis in regular tui output', () => {
  const rendered = formatTuiMarkdownOutput(
    'Also **Add pricing signals.** -> should be formatted.',
    80,
  );

  expect(stripAnsi(rendered)).toBe(
    '  Also Add pricing signals. -> should be formatted.',
  );
  expect(rendered).toContain('\x1b[1mAdd pricing signals.\x1b[22m');
  expect(rendered).not.toContain('\x1b[0m');
});

test('keeps wide glyph markdown table rows inside the terminal width', () => {
  const text = [
    '| Label | Notes |',
    '|-------|-------|',
    '| CJK | 界界界界界界界界 wraps without overflowing borders |',
    '| Emoji | 🪼🪼🪼 markers also stay inside the table |',
  ].join('\n');

  const rendered = formatTuiMarkdownOutput(text, 36);
  const lines = rendered.split('\n');

  expect(stripAnsi(rendered)).toContain('界界');
  expect(lines.every((line) => visibleTuiLength(line) <= 36)).toBe(true);
});

test('delegate text suppression only remains active while delegate tools are in flight', () => {
  let activeCount = 0;

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'start',
  });
  expect(activeCount).toBe(1);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'bash',
    phase: 'start',
  });
  expect(activeCount).toBe(1);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'finish',
  });
  expect(activeCount).toBe(0);

  activeCount = nextActiveDelegateToolCount(activeCount, {
    toolName: 'delegate',
    phase: 'finish',
  });
  expect(activeCount).toBe(0);
});
