import { expect, test, vi } from 'vitest';
import { useCleanMocks } from './test-utils.js';

useCleanMocks({ unstubAllGlobals: true, resetModules: true });

const body =
  'This section describes the material, its preparation, and the observations recorded during the study. '.repeat(
    12,
  );
function group(label: string, attrs = '') {
  return `<div ${attrs}><h2>${label}</h2><span>[<a href="?edit=1">Edit</a>]</span></div>`;
}
async function extract(
  content: string,
  extractMode: 'markdown' | 'text' = 'markdown',
) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          `<html><head><title>Field guide</title></head><body><article><h1>Field guide</h1>${content}</article></body></html>`,
          { headers: { 'Content-Type': 'text/html' } },
        ),
    ),
  );
  const { webFetch } = await import('../container/src/web-fetch.js');
  return webFetch({ url: 'https://93.184.216.34/guide', extractMode });
}

test.each(['Notes', '摘要'])(
  'preserves a short section heading beside inline links: %s',
  async (label) => {
    const result = await extract(
      `${group(label)}<p>${body}</p>${group('Data')}<p>${body}</p>`,
    );
    expect(result.text).toContain(`## ${label}`);
    expect(result.text).toContain('## Data');
    expect(result.text).toContain('observations recorded');
  },
);

test('text extraction retains the section label without Markdown markers', async () => {
  const result = await extract(`${group('Notes')}<p>${body}</p>`, 'text');
  expect(result.text).toContain('Notes');
  expect(result.text).not.toContain('##');
});

test.each([
  'hidden',
  'aria-hidden="true"',
  'style="display:none"',
  'role="navigation"',
  'class="sidebar"',
])('does not expose excluded heading groups: %s', async (attrs) => {
  const result = await extract(
    `${group('Private heading', attrs)}${group('Notes')}<p>${body}</p>`,
  );
  expect(result.text).not.toContain('Private heading');
  expect(result.text).toContain('## Notes');
});

test('leaves ordinary article sections and nested headings intact', async () => {
  const result = await extract(
    `<div><h2>Notes</h2><p>${body}</p><h3>Details</h3><p>${body}</p></div>`,
  );
  expect(result.text).toContain('## Notes');
  expect(result.text).toContain('### Details');
  expect(result.text.match(/observations recorded/g)).toHaveLength(24);
});

test('preserves direct text beside a heading and inline controls', async () => {
  const result = await extract(
    `<div>Published status.<h2>Notes</h2><span><a href="?edit=1">Edit</a></span>${body}</div><p>${body}</p>`,
  );
  expect(result.text).toContain('Published status.');
  expect(result.text).toContain('## Notes');
  expect(result.text.match(/observations recorded/g)).toHaveLength(24);
});
