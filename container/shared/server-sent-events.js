export function drainServerSentEventBlocks(buffer) {
  const blocks = buffer.split(/\r?\n\r?\n/);
  return {
    blocks: blocks.slice(0, -1),
    remainder: blocks.at(-1) || '',
  };
}

export function parseServerSentEventBlock(block) {
  const lines = block.split(/\r?\n/);
  const dataLines = [];
  let event = null;

  for (const rawLine of lines) {
    if (!rawLine || rawLine.startsWith(':')) continue;

    const separatorIndex = rawLine.indexOf(':');
    const field =
      separatorIndex === -1 ? rawLine.trim() : rawLine.slice(0, separatorIndex);
    const value =
      separatorIndex === -1
        ? ''
        : rawLine.slice(separatorIndex + 1).replace(/^ /, '');

    if (field === 'event') {
      event = value || null;
      continue;
    }

    if (field === 'data') dataLines.push(value);
  }

  if (dataLines.length === 0) return null;
  return {
    event,
    data: dataLines.join('\n'),
  };
}
