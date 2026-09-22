/**
 * Math tokens preserve TeX until KaTeX renders it, outside raw-HTML sanitization.
 * Unlike markdown.ts, this module never accepts HTML: only generated, untrusted-mode
 * KaTeX output can replace a per-render placeholder. Code remains the lexer's domain.
 */
import katex from 'katex';
import type { MarkedExtension } from 'marked';

export function createMathRenderer(): {
  extension: MarkedExtension;
  restore: (html: string) => string;
} {
  const prefix = `math-${Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) => value.toString(16)).join('-')}`;
  const equations: string[] = [];
  const render = (text: string, displayMode: boolean): string => {
    const index = equations.length;
    equations.push(
      katex.renderToString(text, {
        displayMode,
        throwOnError: false,
        trust: false,
        strict: 'ignore',
        // 2026-09-22 (renderer implementation): bound untrusted layout and macro
        // expansion; operator-configurable math limits are deliberately deferred.
        maxSize: 20,
        maxExpand: 1000,
      }),
    );
    return `<span class="${prefix}-${index}"></span>`;
  };

  return {
    extension: {
      extensions: [
        {
          name: 'blockMath',
          level: 'block',
          start: (source) => source.search(/^(?: {0,3})(?:\$\$|\\\[)/m),
          tokenizer(source) {
            const match =
              /^ {0,3}(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])[ \t]*(?:\n|$)/.exec(
                source,
              );
            if (!match) return undefined;
            return {
              type: 'blockMath',
              raw: match[0],
              text: match[1] ?? match[2],
            };
          },
          renderer: (token) => `${render(token.text, true)}\n`,
        },
        {
          name: 'inlineMath',
          level: 'inline',
          start: (source) => source.search(/\$|\\\(/),
          tokenizer(source) {
            const match =
              /^(?:\$\$((?:\\[^\n]|[^\\$\n])+?)\$\$|\$(?!\s)((?:\\[^\n]|[^\\$\n])+?)(?<!\s)\$(?!\d)|\\\(((?:\\[^\n]|[^\\\n])+?)\\\))/.exec(
                source,
              );
            if (!match) return undefined;
            return {
              type: 'inlineMath',
              raw: match[0],
              text: match[1] ?? match[2] ?? match[3],
              display: match[1] !== undefined,
            };
          },
          renderer: (token) => render(token.text, token.display),
        },
      ],
    },
    // The nonce prevents user HTML from impersonating generated placeholders.
    // Match complete elements, never text inside attributes or code spans.
    restore: (html) =>
      html.replace(
        new RegExp(`<span class="${prefix}-(\\d+)"></span>`, 'g'),
        (placeholder, index: string) => equations[Number(index)] ?? placeholder,
      ),
  };
}
