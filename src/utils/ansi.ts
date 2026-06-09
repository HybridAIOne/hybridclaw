export type AnsiResetMode = 'never' | 'ansi' | 'always';

export interface TruncateAnsiOptions {
  ellipsis?: string;
  reset?: string;
  resetMode?: AnsiResetMode;
  includeEllipsis?: boolean;
}

export function getAnsiSequenceLength(value: string, index: number): number {
  const code = value.charCodeAt(index);
  if (code !== 27 && code !== 0x9b) {
    return 0;
  }

  if (code === 0x9b) {
    return getControlSequenceLength(value, index, index + 1);
  }

  const next = value.charCodeAt(index + 1);
  if (next === 0x5b) {
    return getControlSequenceLength(value, index, index + 2);
  }

  if (
    (next >= 0x40 && next <= 0x5a) ||
    next === 0x5c ||
    next === 0x5d ||
    next === 0x5e ||
    next === 0x5f
  ) {
    return 2;
  }

  return 0;
}

export function stripAnsi(value: string): string {
  const source = String(value || '');
  let output = '';
  for (let index = 0; index < source.length; ) {
    const ansiSequenceLength = getAnsiSequenceLength(source, index);
    if (ansiSequenceLength > 0) {
      index += ansiSequenceLength;
      continue;
    }

    output += source[index] || '';
    index += 1;
  }
  return output;
}

export function visibleAnsiWidth(value: string): number {
  const source = String(value || '');
  let width = 0;
  for (let index = 0; index < source.length; ) {
    const ansiSequenceLength = getAnsiSequenceLength(source, index);
    if (ansiSequenceLength > 0) {
      index += ansiSequenceLength;
      continue;
    }

    const codePoint = source.codePointAt(index);
    const symbol =
      codePoint == null ? source[index] || '' : String.fromCodePoint(codePoint);
    width += terminalCharCellWidth(symbol);
    index += symbol.length || 1;
  }
  return width;
}

export function truncateAnsi(
  value: string,
  width: number,
  options: TruncateAnsiOptions = {},
): string {
  if (width <= 0) return '';

  const source = String(value || '');
  if (visibleAnsiWidth(source) <= width) return source;

  const ellipsis = options.ellipsis ?? '…';
  const includeEllipsis = options.includeEllipsis ?? true;
  const marker = includeEllipsis ? ellipsis : '';
  const markerWidth = visibleAnsiWidth(marker);
  const targetWidth = Math.max(0, width - markerWidth);
  let output = '';
  let visibleWidth = 0;
  let hasAnsi = false;

  for (let index = 0; index < source.length; ) {
    const ansiSequenceLength = getAnsiSequenceLength(source, index);
    if (ansiSequenceLength > 0) {
      hasAnsi = true;
      output += source.slice(index, index + ansiSequenceLength);
      index += ansiSequenceLength;
      continue;
    }

    const codePoint = source.codePointAt(index);
    const symbol =
      codePoint == null ? source[index] || '' : String.fromCodePoint(codePoint);
    const symbolWidth = terminalCharCellWidth(symbol);
    if (symbolWidth > 0 && visibleWidth + symbolWidth > targetWidth) {
      break;
    }

    output += symbol;
    visibleWidth += symbolWidth;
    index += symbol.length || 1;
  }

  if (marker) {
    output += marker;
  }

  const reset = options.reset ?? '';
  const resetMode = options.resetMode ?? 'never';
  if (
    reset &&
    !output.endsWith(reset) &&
    (resetMode === 'always' || (resetMode === 'ansi' && hasAnsi))
  ) {
    output += reset;
  }

  return output;
}

export function terminalCellWidth(text: string): number {
  let width = 0;
  for (const char of String(text || '')) {
    width += terminalCharCellWidth(char);
  }
  return width;
}

export function terminalCharCellWidth(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isZeroWidthCodePoint(codePoint)) return 0;
  return isWideCodePoint(codePoint) ? 2 : 1;
}

function getControlSequenceLength(
  value: string,
  index: number,
  cursor: number,
): number {
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor - index + 1;
    }
    cursor += 1;
  }

  return 0;
}

function isZeroWidthCodePoint(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f) ||
    (codePoint >= 0x1ab0 && codePoint <= 0x1aff) ||
    (codePoint >= 0x1dc0 && codePoint <= 0x1dff) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x20d0 && codePoint <= 0x20ff) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f) ||
    (codePoint >= 0xfe20 && codePoint <= 0xfe2f) ||
    (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x2600 && codePoint <= 0x27bf) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}
