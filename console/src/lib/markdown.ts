import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const CHAT_MARKDOWN_SANITIZE_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'a',
    'blockquote',
    'br',
    'code',
    'del',
    'em',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'hr',
    'li',
    'ol',
    'p',
    'pre',
    'strong',
    'table',
    'tbody',
    'td',
    'th',
    'thead',
    'tr',
    'ul',
  ],
  allowedAttributes: {
    a: ['href', 'rel', 'target', 'title'],
    code: ['class'],
    td: ['style'],
    th: ['style'],
  },
  allowedStyles: {
    td: {
      'text-align': [/^left$/, /^center$/, /^right$/],
    },
    th: {
      'text-align': [/^left$/, /^center$/, /^right$/],
    },
  },
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesAppliedToAttributes: ['href'],
  allowProtocolRelative: false,
  transformTags: {
    a: sanitizeHtml.simpleTransform(
      'a',
      {
        rel: 'noopener noreferrer',
        target: '_blank',
      },
      true,
    ),
  },
};

export function renderMarkdown(raw: string): string {
  const normalized = String(raw || '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) return '';

  const rendered = marked.parse(normalized, {
    async: false,
    breaks: true,
    gfm: true,
  });

  return sanitizeHtml(
    typeof rendered === 'string' ? rendered : String(rendered || ''),
    CHAT_MARKDOWN_SANITIZE_OPTIONS,
  ).trim();
}
