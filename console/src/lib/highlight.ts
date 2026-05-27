import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

// Only the languages that realistically show up in chat are registered, via the
// per-language entry points so the bundle stays lean (core + a handful of
// grammars rather than all ~190). Each grammar also registers its own aliases
// (ts, js, sh, html, py, yml, rs, …), so we don't map those by hand.
const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash,
  css,
  diff,
  go,
  javascript,
  json,
  markdown,
  python,
  rust,
  sql,
  typescript,
  xml,
  yaml,
};

for (const [name, definition] of Object.entries(LANGUAGES)) {
  hljs.registerLanguage(name, definition);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Markdown info strings are arbitrary text; keep only characters real language
// identifiers use so the value is safe to drop into a class attribute.
function normalizeLanguage(infostring: string | undefined): string {
  return (
    (infostring ?? '')
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase()
      .replace(/[^a-z0-9#+._-]/g, '') ?? ''
  );
}

/**
 * Render a fenced code block to sanitized-friendly HTML. When the language is
 * known to highlight.js we emit `<span class="hljs-…">` tokens (highlight.js
 * escapes the code for us); otherwise we fall back to plain escaped text, which
 * matches the pre-highlighting behaviour. The result is still run through
 * sanitize-html by the caller, which only allows `span[class]`.
 */
export function highlightCodeBlock(
  rawCode: string,
  infostring?: string,
): string {
  const code = String(rawCode ?? '');
  const language = normalizeLanguage(infostring);
  const languageClass = language ? ` language-${language}` : '';

  if (language && hljs.getLanguage(language)) {
    try {
      const { value } = hljs.highlight(code, {
        language,
        ignoreIllegals: true,
      });
      return `<pre><code class="hljs${languageClass}">${value}</code></pre>\n`;
    } catch {
      // Fall through to the plain escaped rendering below.
    }
  }

  return `<pre><code class="hljs${languageClass}">${escapeHtml(code)}</code></pre>\n`;
}
