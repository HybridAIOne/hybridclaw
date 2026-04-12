// Ported from the legacy docs/chat.html inline renderer.

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(raw: string): string {
  return String(raw).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch]);
}

function sanitizeUrl(rawUrl: string): string {
  const url = String(rawUrl || '').trim();
  if (!url) return '';
  const lowered = url.toLowerCase();
  if (
    lowered.startsWith('http://') ||
    lowered.startsWith('https://') ||
    lowered.startsWith('mailto:')
  ) {
    return url;
  }
  return '';
}

function renderInlineMarkdown(raw: string): string {
  let text = String(raw || '');
  const inlineCode: string[] = [];
  const links: string[] = [];

  text = text.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const idx = inlineCode.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `@@IC${idx}@@`;
  });

  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_match, label: string, href: string) => {
      const safeHref = sanitizeUrl(href);
      const safeLabel = escapeHtml(label);
      const html = safeHref
        ? `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${safeLabel}</a>`
        : safeLabel;
      const idx = links.push(html) - 1;
      return `@@LK${idx}@@`;
    },
  );

  text = escapeHtml(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  text = text.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  text = text.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  text = text.replace(/_([^_]+)_/g, '<em>$1</em>');

  text = text.replace(
    /@@LK(\d+)@@/g,
    (_match, index: string) => links[Number(index)] || '',
  );
  text = text.replace(
    /@@IC(\d+)@@/g,
    (_match, index: string) => inlineCode[Number(index)] || '',
  );
  return text;
}

function splitMarkdownTableRow(line: string): string[] {
  let value = String(line || '').trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|')) value = value.slice(0, -1);
  return value.split('|').map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line: string): boolean {
  const cells = splitMarkdownTableRow(line);
  if (!cells.length) return false;
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isMarkdownTableBodyRow(line: string): boolean {
  const trimmed = String(line || '').trim();
  return (
    trimmed.includes('|') &&
    trimmed !== '|' &&
    !isMarkdownTableSeparator(trimmed)
  );
}

function cellAlignment(separatorCell: string): 'left' | 'center' | 'right' {
  const trimmed = String(separatorCell || '').trim();
  if (trimmed.startsWith(':') && trimmed.endsWith(':')) return 'center';
  if (trimmed.endsWith(':')) return 'right';
  return 'left';
}

function renderMarkdownTable(
  headerLine: string,
  separatorLine: string,
  bodyLines: string[],
): string {
  const headers = splitMarkdownTableRow(headerLine);
  const separators = splitMarkdownTableRow(separatorLine);
  const alignments = headers.map((_, index) =>
    cellAlignment(separators[index] || '---'),
  );
  const bodyRows = bodyLines.map((line) => splitMarkdownTableRow(line));

  const thead = `<thead><tr>${headers
    .map(
      (cell, index) =>
        `<th style="text-align:${alignments[index]}">${renderInlineMarkdown(cell)}</th>`,
    )
    .join('')}</tr></thead>`;
  const tbody = `<tbody>${bodyRows
    .map(
      (row) =>
        `<tr>${headers
          .map(
            (_, index) =>
              `<td style="text-align:${alignments[index]}">${renderInlineMarkdown(row[index] || '')}</td>`,
          )
          .join('')}</tr>`,
    )
    .join('')}</tbody>`;
  return `<div class="md-table-wrap"><table>${thead}${tbody}</table></div>`;
}

export function renderMarkdown(raw: string): string {
  let text = String(raw || '').replace(/\r\n/g, '\n');
  const codeBlocks: string[] = [];

  text = text.replace(
    /```([^\n`]*)\n([\s\S]*?)```/g,
    (_match, _lang: string, code: string) => {
      const idx =
        codeBlocks.push(
          `<pre><code>${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`,
        ) - 1;
      return `@@CB${idx}@@`;
    },
  );

  const lines = text.split('\n');
  const out: string[] = [];
  let paragraphLines: string[] = [];
  let openList = '';

  const closeList = (): void => {
    if (openList) {
      out.push(openList === 'ul' ? '</ul>' : '</ol>');
      openList = '';
    }
  };

  const flushParagraph = (): void => {
    if (paragraphLines.length === 0) return;
    const html = paragraphLines
      .map((line) => renderInlineMarkdown(line))
      .join('<br>');
    out.push(`<p>${html}</p>`);
    paragraphLines = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const codeMatch = line.match(/^@@CB(\d+)@@$/);
    if (codeMatch) {
      flushParagraph();
      closeList();
      out.push(codeBlocks[Number(codeMatch[1])] || '');
      index += 1;
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      if (openList) {
        let ahead = index + 1;
        while (ahead < lines.length && !(lines[ahead] || '').trim()) ahead++;
        const nextNonEmpty = ahead < lines.length ? lines[ahead] : '';
        const continuesList =
          (openList === 'ul' && /^\s*[-*+]\s+/.test(nextNonEmpty)) ||
          (openList === 'ol' && /^\s*\d+\.\s+/.test(nextNonEmpty));
        if (!continuesList) closeList();
      }
      index += 1;
      continue;
    }

    const nextLine = lines[index + 1] || '';
    if (line.includes('|') && isMarkdownTableSeparator(nextLine)) {
      flushParagraph();
      closeList();
      const bodyLines: string[] = [];
      let tableIndex = index + 2;
      while (
        tableIndex < lines.length &&
        isMarkdownTableBodyRow(lines[tableIndex])
      ) {
        bodyLines.push(lines[tableIndex]);
        tableIndex += 1;
      }
      out.push(renderMarkdownTable(line, nextLine, bodyLines));
      index = tableIndex;
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushParagraph();
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      closeList();
      out.push(`<blockquote>${renderInlineMarkdown(quote[1])}</blockquote>`);
      index += 1;
      continue;
    }

    const hline = line.match(/^\s*((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})\s*$/);
    if (hline) {
      flushParagraph();
      closeList();
      out.push('<hr>');
      index += 1;
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.*)$/);
    if (unordered) {
      flushParagraph();
      if (openList !== 'ul') {
        closeList();
        out.push('<ul>');
        openList = 'ul';
      }
      out.push(`<li>${renderInlineMarkdown(unordered[1])}</li>`);
      index += 1;
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.*)$/);
    if (ordered) {
      flushParagraph();
      if (openList !== 'ol') {
        closeList();
        out.push('<ol>');
        openList = 'ol';
      }
      out.push(`<li>${renderInlineMarkdown(ordered[1])}</li>`);
      index += 1;
      continue;
    }

    paragraphLines.push(line);
    index += 1;
  }

  flushParagraph();
  closeList();

  return out
    .join('\n')
    .replace(/@@CB(\d+)@@/g, (_m, i: string) => codeBlocks[Number(i)] || '');
}
