import { Marked, type Tokens } from 'marked';
import sanitizeHtml from 'sanitize-html';
import { highlightCodeBlock } from './highlight';

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
    'span',
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
    ol: ['start'],
    // syntax-highlight token spans emitted by highlight.js, e.g.
    // <span class="hljs-keyword">. Class values can't execute, so allowing
    // the attribute on span is safe.
    span: ['class'],
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

function createMarked(highlight: boolean): Marked {
  const instance = new Marked({ async: false, breaks: true, gfm: true });
  instance.use({
    renderer: {
      // marked v16+ passes a token object; older signatures pass (code, lang).
      // Handle both so this keeps working across marked upgrades.
      code(codeOrToken: string | Tokens.Code, infostring?: string): string {
        const text =
          typeof codeOrToken === 'string' ? codeOrToken : codeOrToken.text;
        const lang =
          typeof codeOrToken === 'string' ? infostring : codeOrToken.lang;
        return highlightCodeBlock(text, lang, highlight);
      },
    },
  });
  return instance;
}

// Two preconfigured instances rather than re-registering the renderer per call.
// The plain one skips syntax highlighting for streaming renders (see
// renderMarkdown's `highlight` option).
const markdownHighlighted = createMarked(true);
const markdownPlain = createMarked(false);

export function renderMarkdown(
  raw: string,
  options?: { highlight?: boolean },
): string {
  const normalized = String(raw || '')
    .replace(/\r\n/g, '\n')
    // LLMs frequently emit numbered headings wrapped entirely in bold
    // (`**1. Heading**`). That's a paragraph to CommonMark, so each "N."
    // renders as literal text instead of an ordered-list counter (#320).
    // Rewrite to `N. **Heading**` so marked treats it as a real list item.
    .replace(/^(\s*)\*\*(\d+)\.\s+(.+?)\*\*\s*$/gm, '$1$2. **$3**');
  if (!normalized.trim()) return '';

  const instance =
    options?.highlight === false ? markdownPlain : markdownHighlighted;
  const rendered = instance.parse(normalized);

  return sanitizeHtml(
    typeof rendered === 'string' ? rendered : String(rendered || ''),
    CHAT_MARKDOWN_SANITIZE_OPTIONS,
  ).trim();
}
