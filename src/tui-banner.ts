import { detectRuntimeProviderPrefix } from './providers/task-routing.js';
import { visibleAnsiWidth } from './utils/ansi.js';

export interface TuiBannerPalette {
  reset: string;
  bold: string;
  muted: string;
  teal: string;
  gold: string;
  green: string;
  activeSkill: string;
  inactiveSkill: string;
  wordmarkRamp?: readonly string[];
}

export interface TuiStartupBannerSkillCategory {
  category: string;
  skills: Array<{
    name: string;
    active: boolean;
  }>;
}

export interface TuiStartupBannerInfo {
  currentModel: string;
  defaultModel: string;
  sandboxMode: 'container' | 'host';
  gatewayBaseUrl: string;
  hybridAIBaseUrl: string;
  chatbotId: string;
  version: string;
  skillCategories: TuiStartupBannerSkillCategory[];
}

const SIDE_BY_SIDE_GAP = 4;
const MIN_PANEL_WIDTH = 42;

const JELLYFISH_ART = [
  '⠀⠀⠀⠀⠀⠀⠀⠀◌⠀⠀⠀⠀⠀⣀⣠⣤⣤⣤⣤⣄⣀⡀⠀⠀⠀⠀∘⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣤⠾⠏⠉⠀⠀⠀⠀⠀⠀⠈⠉⠳⢶⣄⡀⠀⠀○',
  '⠀⠀⠀⠀⠀⠀⠀⠀⢠⡟⠁⠀⠀⠀⠸⠿⠀⠀⠀⠀⠀⠶⠇⠙⢿⣄⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⢠⡿⢱⡟⠓⣆⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢰⣶⡄⢻⡆⠀',
  '⠀⠀⠀⠀⠀⠀⠀⢸⣧⡈⠙⠛⠁⠀    ⠀⠀⠀⣀⣀⠀⠀⠁⠀⠈⣿⡀',
  '⠀⠀⠀⠀⠀⠀⠀⠸⢍⣻⣦⣄⡀⠀     ⠀⠸⠿⠿⠇⠀⣠⠶⣦⣿⠃',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⢘⣧⣈⣻⡷⢶⣦⣀⣀⠀⠀⠀⠀⠀⠀⠈⢛⢡⡟⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣳⠃⡹⠳⡤⡴⡏⠙⠛⣻⠶⠶⢤⡤⠤⠶⣿⠁⠀',
  '⠀⠀⠀⢀⣠⣤⣶⠶⠋⣵⠋⢰⠇⣼⣱⠁⢹⠗⢲⡟⠦⣤⠼⠛⠦⠞⠃⠀⠀',
  '⠀⢀⣴⡿⠋⠁⢠⣰⠞⠁⣰⣯⣼⠁⡏⠀⢸⠀⠸⡇⠀⢸⠀⠀⠀⠀⠀⠀⠀',
  '⠀⣼⠋⢀⣠⡴⣟⢁⣠⡞⢻⡿⠁⢰⡇⠀⢸⣄⠀⢷⠀⠸⣆⠀⠀⠀⠀⠀⠀',
  '⢸⢇⣴⡿⠋⠄⣼⡿⠁⠀⣾⠁⠀⠸⡇⠀⠀⢿⡄⠘⣆⠀⠹⣦⠀⠀⠀⠀⠀',
  '⢠⣾⠏⠀⠀⢠⣿⠀⠀⠀⣿⡄⠀⠀⢿⠀⠀⠈⣷⡄⠹⣧⠀⠙⢷⣄⠀⠀⠀',
  '⢸⡟⠀⠀⠀⢸⣿⠀⠀⠀⢹⣧⠀⠀⠸⣷⠀⠀⠸⣷⡀⠹⣦⠀⠀⠻⣧⠀⠀',
  '⢸⡇⠀⠀⠀⠀⣿⡆⠀⠀⠀⢻⣧⠀⠀⢻⡆⠀⠀⠹⣧⠀⠹⣇⠀⠀⢻⣧⠀',
  '⢸⣇⠀⠀⠀⠀⠘⣿⣄⠀⠀⠀⠹⣧⠀⠘⣿⠀⠀⠀⣿⡇⠀⢿⣄⠀⠀⣿⡇',
  '⢈⣿⡄⠀⠀⠀⠀⠘⣿⣄⠀⠀⠀⠈⠣⡀⢿⡆⠀⠀⣿⠃⠀⠘⣿⡀⠀⢸⡇',
  '⠀⠘⠃⠀⠀⠀⠀⠀⠈⢿⣧⠀⠀⠀⠀⠀⢸⣷⠀⠀⠀⠀⠀⠀⣿⡇⠀⢸⡇',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠙⣧⡀⠀⠀⠀⢸⣿⠀⠀⠀⠀⠀⠀⣿⡇⠀⡾⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠳⡄⠀⠀⣸⡏⠀⠀⠀⠀⠀⣸⡟⠀⠀⠁⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⢦⢀⡿⠀⠀⠀⠀⢀⣴⠟⠀⠀⠀◦⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢀⣼⣿⠃⠀⠀⠀⣠⡿⠁⠀⠀⠀○⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣰⠟⠁⠙⣧⠀⢀⡴⠋⠀⠀⠀⠀◌⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⣼⠃⠀⠀⠀⠈⣷⡟⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⢸⡇⣀⡴⠂⠀⣠⠟⣳⡄⠀⠀⠀⠀⠀∘⠀⠀⠀⠀',
  '⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠛⠋⠀⠀⠀⠛⠛⠁⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀',
] as const;

const HYBRIDCLAW_WORDMARK = [
  '░██     ░██ ░██     ░██ ░████████   ░█████████  ░██████░███████     ░██████  ░██            ░███    ░██       ░██',
  '░██     ░██  ░██   ░██  ░██    ░██  ░██     ░██   ░██  ░██   ░██   ░██   ░██ ░██           ░██░██   ░██       ░██',
  '░██     ░██   ░██ ░██   ░██    ░██  ░██     ░██   ░██  ░██    ░██ ░██        ░██          ░██  ░██  ░██  ░██  ░██',
  '░██████████    ░████    ░████████   ░█████████    ░██  ░██    ░██ ░██        ░██         ░█████████ ░██ ░████ ░██',
  '░██     ░██     ░██     ░██     ░██ ░██   ░██     ░██  ░██    ░██ ░██        ░██         ░██    ░██ ░██░██ ░██░██',
  '░██     ░██     ░██     ░██     ░██ ░██    ░██    ░██  ░██   ░██   ░██   ░██ ░██         ░██    ░██ ░████   ░████',
  '░██     ░██     ░██     ░█████████  ░██     ░██ ░██████░███████     ░██████  ░██████████ ░██    ░██ ░███     ░███',
] as const;

const SLASH_COMMANDS = [
  '/agent',
  '/approve',
  '/audit',
  '/auth',
  '/bot',
  '/channel-mode',
  '/channel-policy',
  '/clear',
  '/compact',
  '/config',
  '/dream',
  '/exit',
  '/export',
  '/fullauto',
  '/goal',
  '/help',
  '/info',
  '/mcp',
  '/model',
  '/policy',
  '/rag',
  '/ralph',
  '/reset',
  '/schedule',
  '/sessions',
  '/show',
  '/skill',
  '/status',
  '/stop',
  '/usage',
] as const;

function maxVisibleLength(lines: readonly string[]): number {
  return lines.reduce((max, line) => Math.max(max, visibleAnsiWidth(line)), 0);
}

function padVisibleEnd(value: string, width: number): string {
  return `${value}${' '.repeat(Math.max(0, width - visibleAnsiWidth(value)))}`;
}

function wrapValue(label: string, rawValue: string, width: number): string[] {
  const safeValue = String(rawValue || '').trim() || 'unset';
  const labelWidth = 9;
  const firstPrefix = `${label.padEnd(labelWidth)} `;
  const nextPrefix = ' '.repeat(firstPrefix.length);
  const lines: string[] = [];

  let remaining = safeValue;
  let prefix = firstPrefix;

  while (remaining) {
    const available = Math.max(1, width - prefix.length);
    if (remaining.length <= available) {
      lines.push(`${prefix}${remaining}`);
      break;
    }

    let sliceEnd = available;
    while (sliceEnd > 0 && remaining[sliceEnd] && remaining[sliceEnd] !== ' ') {
      sliceEnd -= 1;
    }
    if (sliceEnd <= 0) sliceEnd = available;

    const segment = remaining.slice(0, sliceEnd).trimEnd();
    lines.push(`${prefix}${segment}`);
    remaining = remaining.slice(sliceEnd).trimStart();
    prefix = nextPrefix;
  }

  return lines.length > 0 ? lines : [`${firstPrefix}unset`];
}

function buildSkillRows(params: {
  categories: TuiStartupBannerSkillCategory[];
  width: number;
  palette: TuiBannerPalette;
}): string[] {
  const { categories, width, palette } = params;
  const tokens: Array<{
    visible: string;
    colored: string;
    wrappedVisible?: string;
    wrappedColored?: string;
  }> = [];

  for (const [categoryIndex, category] of categories.entries()) {
    const categoryLabel = `${category.category}:`;
    tokens.push({
      visible: categoryIndex === 0 ? categoryLabel : `- ${category.category}:`,
      colored:
        categoryIndex === 0
          ? `${palette.gold}${category.category}:${palette.reset}`
          : `- ${palette.gold}${category.category}:${palette.reset}`,
      wrappedVisible: categoryLabel,
      wrappedColored: `${palette.gold}${category.category}:${palette.reset}`,
    });

    if (category.skills.length === 0) {
      tokens.push({
        visible: 'none',
        colored: `${palette.inactiveSkill}none${palette.reset}`,
      });
      continue;
    }

    for (const [skillIndex, skill] of category.skills.entries()) {
      const visibleName =
        skillIndex < category.skills.length - 1 ? `${skill.name},` : skill.name;
      tokens.push({
        visible: visibleName,
        colored: `${skill.active ? palette.activeSkill : palette.inactiveSkill}${visibleName}${palette.reset}`,
      });
    }
  }

  const rows: string[] = [];
  let current = '';
  let currentVisible = 0;

  for (const token of tokens) {
    const space = current ? ' ' : '';
    const nextVisible = currentVisible + space.length + token.visible.length;
    if (current && nextVisible > width) {
      rows.push(current);
      current = token.wrappedColored || token.colored;
      currentVisible = (token.wrappedVisible || token.visible).length;
      continue;
    }
    current += `${space}${token.colored}`;
    currentVisible = nextVisible;
  }

  if (current) {
    rows.push(current);
  }
  return rows;
}

function chunkCommands(width: number): string[] {
  const longest = SLASH_COMMANDS.reduce(
    (max, command) => Math.max(max, command.length),
    0,
  );
  const columnWidth = longest + 3;
  const columns = Math.max(
    1,
    Math.min(
      SLASH_COMMANDS.length,
      Math.floor((Math.max(width, columnWidth) + 3) / columnWidth),
    ),
  );
  const rows = Math.ceil(SLASH_COMMANDS.length / columns);
  const lines: string[] = [];

  for (let row = 0; row < rows; row += 1) {
    const entries: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      const index = row + column * rows;
      const command = SLASH_COMMANDS[index];
      if (!command) continue;
      const isLastColumn = column === columns - 1;
      entries.push(isLastColumn ? command : command.padEnd(columnWidth));
    }
    lines.push(entries.join(''));
  }

  return lines;
}

function resolveProviderLabel(model: string): string {
  switch (detectRuntimeProviderPrefix(model)) {
    case 'openai':
      return 'OpenAI API';
    case 'openai-codex':
      return 'Codex';
    case 'openrouter':
      return 'OpenRouter';
    case 'huggingface':
      return 'Hugging Face';
    case 'ollama':
      return 'Ollama';
    case 'lmstudio':
      return 'LM Studio';
    case 'llamacpp':
      return 'llama.cpp';
    case 'mlx':
      return 'MLX';
    case 'vllm':
      return 'vLLM';
    default:
      return 'HybridAI';
  }
}

function renderPanel(
  width: number,
  info: TuiStartupBannerInfo,
  palette: TuiBannerPalette,
  targetHeight?: number,
): string[] {
  const innerWidth = Math.max(16, width - 4);
  const lines: string[] = [];

  const pushBorder = (
    left: '╭' | '├' | '╰',
    fill: string,
    right: '╮' | '┤' | '╯',
  ) => {
    lines.push(
      `${palette.muted}${left}${fill.repeat(innerWidth + 2)}${right}${palette.reset}`,
    );
  };

  const pushRow = (text = '', color = '') => {
    const body = padVisibleEnd(text, innerWidth);
    const content = color ? `${color}${body}${palette.reset}` : body;
    lines.push(
      `${palette.muted}│${palette.reset} ${content} ${palette.muted}│${palette.reset}`,
    );
  };

  pushBorder('╭', '─', '╮');
  pushRow(`Runtime (v${info.version})`, `${palette.bold}${palette.gold}`);
  for (const line of [
    ...wrapValue(
      'model',
      `${info.currentModel} (${resolveProviderLabel(info.currentModel)})`,
      innerWidth,
    ),
    ...wrapValue('bot', info.chatbotId, innerWidth),
    ...wrapValue(
      'gateway',
      `${info.gatewayBaseUrl} (${info.sandboxMode} mode)`,
      innerWidth,
    ),
  ]) {
    pushRow(line);
  }

  pushBorder('├', '─', '┤');
  pushRow('Skills', `${palette.bold}${palette.gold}`);
  if (info.skillCategories.length === 0) {
    pushRow(`${palette.inactiveSkill}None${palette.reset}`);
  } else {
    for (const line of buildSkillRows({
      categories: info.skillCategories,
      width: innerWidth,
      palette,
    })) {
      pushRow(line);
    }
  }

  pushBorder('├', '─', '┤');
  pushRow('Slash Commands', `${palette.bold}${palette.gold}`);
  for (const line of chunkCommands(innerWidth)) {
    pushRow(line, palette.teal);
  }
  while (typeof targetHeight === 'number' && lines.length + 1 < targetHeight) {
    pushRow();
  }
  pushBorder('╰', '─', '╯');

  return lines;
}

function renderSideBySide(
  leftLines: readonly string[],
  rightLines: readonly string[],
  gap: number,
): string[] {
  const leftWidth = maxVisibleLength(leftLines);
  const lineCount = Math.max(leftLines.length, rightLines.length);
  const lines: string[] = [];

  for (let index = 0; index < lineCount; index += 1) {
    const left = leftLines[index] || '';
    const right = rightLines[index] || '';
    if (right) {
      lines.push(
        `${padVisibleEnd(left, leftWidth)}${' '.repeat(gap)}${right}`.trimEnd(),
      );
      continue;
    }
    lines.push(left);
  }

  return lines;
}

function renderTitle(
  info: TuiStartupBannerInfo,
  palette: TuiBannerPalette,
): string[] {
  return [
    ...HYBRIDCLAW_WORDMARK.map((line, index) => {
      const color = palette.wordmarkRamp?.[index] || palette.gold;
      return `  ${color}${line}${palette.reset}`;
    }),
    `  ${palette.muted}Powered by HybridAI${palette.reset}  ${palette.teal}v${info.version}${palette.reset}`,
  ];
}

function renderFallbackTitle(
  info: TuiStartupBannerInfo,
  palette: TuiBannerPalette,
): string[] {
  return [
    `  ${palette.bold}${palette.teal}Hybrid${palette.gold}Claw${palette.reset} ${palette.muted}v${info.version}${palette.reset}`,
    `  ${palette.muted}Powered by HybridAI${palette.reset}`,
  ];
}

export function renderTuiStartupBanner(params: {
  columns: number;
  info: TuiStartupBannerInfo;
  palette: TuiBannerPalette;
}): string[] {
  const { columns, info, palette } = params;
  const titleLines = renderTitle(info, palette);
  const wordmarkWidth = maxVisibleLength(titleLines);
  const leftLines = JELLYFISH_ART.map(
    (line) => `  ${palette.teal}${line}${palette.reset}`,
  );
  const leftWidth = maxVisibleLength(leftLines);
  const targetPanelWidth = Math.max(
    MIN_PANEL_WIDTH,
    wordmarkWidth - (leftWidth + SIDE_BY_SIDE_GAP),
  );
  const canRenderSideBySide =
    targetPanelWidth >= MIN_PANEL_WIDTH &&
    columns >= leftWidth + SIDE_BY_SIDE_GAP + targetPanelWidth;
  const rightWidth = canRenderSideBySide
    ? targetPanelWidth
    : Math.max(20, Math.min(targetPanelWidth, columns - 2));
  const rightLines = renderPanel(
    rightWidth,
    info,
    palette,
    canRenderSideBySide ? leftLines.length : undefined,
  );

  const combined = canRenderSideBySide
    ? renderSideBySide(leftLines, rightLines, SIDE_BY_SIDE_GAP)
    : [...leftLines, '', ...rightLines];

  if (columns >= wordmarkWidth) {
    return [...combined, '', ...titleLines];
  }

  return [...combined, '', ...renderFallbackTitle(info, palette)];
}
