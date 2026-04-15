import { describe, expect, it } from 'vitest';
import { renderMarkdown } from './markdown';

describe('renderMarkdown', () => {
  it('renders safe markdown links with hardened link attributes', () => {
    expect(renderMarkdown('[HybridClaw](https://example.com/docs)')).toContain(
      '<a href="https://example.com/docs" rel="noopener noreferrer" target="_blank">HybridClaw</a>',
    );
  });

  it('sanitizes common xss payloads', () => {
    const html = renderMarkdown(`
<script>alert("pwned")</script>
<img src="https://evil.test/x" onerror="alert('xss')">
[bad](javascript:alert(1))
<a href="javascript:alert('owned')" onclick="alert('xss')">raw</a>
    `);

    expect(html).not.toContain('<script');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('onerror=');
    expect(html).not.toContain('onclick=');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain(
      '<a rel="noopener noreferrer" target="_blank">raw</a>',
    );
  });

  it('escapes dangerous html inside code spans', () => {
    expect(renderMarkdown('`<img src=x onerror=alert(1)>`')).toContain(
      '<code>&lt;img src=x onerror=alert(1)&gt;</code>',
    );
  });

  it('keeps basic markdown structure such as tables and lists', () => {
    const html = renderMarkdown(`
| Name | Value |
| :--- | ---: |
| Alpha | 1 |

- first
- second
    `);

    expect(html).toContain('<table>');
    expect(html).toContain('<tbody>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>first</li>');
  });
});
