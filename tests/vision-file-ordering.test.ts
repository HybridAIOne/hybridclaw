import { expect, test } from 'vitest';
import { leadingParallelRun } from '../container/src/tool-parallelism.js';
import type { ToolCall } from '../container/src/types.js';

function call(name: string, args: Record<string, unknown> | string): ToolCall {
  return {
    id: name,
    type: 'function',
    function: {
      name,
      arguments: typeof args === 'string' ? args : JSON.stringify(args),
    },
  };
}

const write = call('write', { path: 'images/chart.svg', contents: '<svg/>' });
const vision = (args: Record<string, unknown> | string) =>
  call('vision_analyze', args);

test.each([
  { image_url: 'images/chart.svg' },
  { imageUrl: '/workspace/images/chart.svg' },
  { path: './images//chart.svg' },
  { image_url: '/api/artifact?path=images%2Fchart.svg' },
  { image_url: 'missing.svg', fallback_url: 'images/chart.svg' },
  { image_url: 'missing.svg', fallbackUrl: 'images/chart.svg' },
  { image_url: 'missing.svg', original_url: 'images/chart.svg' },
])('local vision inputs conflict with writes in either order: %j', (args) => {
  const read = vision(args);
  expect(leadingParallelRun([write, read])).toEqual([write]);
  expect(leadingParallelRun([read, write])).toEqual([read]);
});

test.each([
  { image_url: 'images/other.svg' },
  { image_url: 'images/chart.svg.bak' },
  { image_url: 'https://cdn.discordapp.com/attachments/example/image.png' },
  { snapshot: { id: 'example-snapshot', pages: [] } },
])('independent vision inputs retain concurrency: %j', (args) => {
  const read = vision(args);
  expect(leadingParallelRun([write, read])).toEqual([write, read]);
});

test('multiple readers of the same image share a batch', () => {
  const first = vision({ image_url: 'images/chart.svg' });
  const second = vision({ path: 'images/chart.svg' });
  expect(leadingParallelRun([first, second])).toEqual([first, second]);
});

test.each([
  {},
  { image_url: '/var/example.svg' },
  { image_url: 42 },
  { image_url: 'images/chart.svg', snapshot: { id: 'example-snapshot' } },
  { image_url: '/workspace/.http-artifacts/../outside.svg' },
  '{"image_url":',
])('invalid or unknown vision paths form a barrier: %j', (args) => {
  expect(leadingParallelRun([write, vision(args)])).toEqual([write]);
});
