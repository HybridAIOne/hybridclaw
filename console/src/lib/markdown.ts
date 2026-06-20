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
    a: (_tagName, attribs) => {
      const href = typeof attribs.href === 'string' ? attribs.href : '';
      if (isKnownLocalAppHref(href)) {
        return { tagName: 'a', attribs };
      }
      return {
        tagName: 'a',
        attribs: {
          ...attribs,
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      };
    },
  },
};

const BARE_LOCAL_APP_ROUTE_RE =
  /(^|[\s>])((?:\/(?:admin|chat|docs)(?=$|[/?#\s<`.,;:!?)])(?:[/?#][^\s<`]*)?))/g;

function isKnownLocalAppHref(href: string): boolean {
  return /^\/(?:admin|chat|docs)(?:$|[/?#])/.test(href);
}

function splitTrailingPunctuation(value: string): {
  href: string;
  trailing: string;
} {
  let href = value;
  let trailing = '';
  while (/[.,;:!?)]$/.test(href)) {
    trailing = `${href.at(-1)}${trailing}`;
    href = href.slice(0, -1);
  }
  return { href, trailing };
}

function linkifyBareLocalAppRoutesInSegment(segment: string): string {
  return segment.replace(
    BARE_LOCAL_APP_ROUTE_RE,
    (_match, prefix: string, rawHref: string) => {
      const { href, trailing } = splitTrailingPunctuation(rawHref);
      if (!href) return `${prefix}${rawHref}`;
      return `${prefix}[${href}](${href})${trailing}`;
    },
  );
}

function linkifyLocalAppRouteCodeSpan(segment: string): string | null {
  if (!segment.startsWith('`') || !segment.endsWith('`')) return null;
  const href = segment.slice(1, -1);
  return isKnownLocalAppHref(href) ? `[${href}](${href})` : null;
}

function linkifyBareLocalAppRoutes(markdown: string): string {
  const lines = markdown.split('\n');
  let inFence = false;
  return lines
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      return line
        .split(/(`[^`]*`)/g)
        .map((segment) => {
          const linkedCodeSpan = linkifyLocalAppRouteCodeSpan(segment);
          if (linkedCodeSpan) return linkedCodeSpan;
          return segment.startsWith('`') && segment.endsWith('`')
            ? segment
            : linkifyBareLocalAppRoutesInSegment(segment);
        })
        .join('');
    })
    .join('\n');
}

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
  const rendered = instance.parse(linkifyBareLocalAppRoutes(normalized));

  return sanitizeHtml(
    typeof rendered === 'string' ? rendered : String(rendered || ''),
    CHAT_MARKDOWN_SANITIZE_OPTIONS,
  ).trim();
}
