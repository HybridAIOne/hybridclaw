import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, test, vi } from 'vitest';
import { handleWorkToolRoute } from '../src/work/work-routes.js';

test('an unauthorized work request is refused before reading its body', async () => {
  const request = { [Symbol.asyncIterator]() { throw new Error('Body must not be read'); } };
  const response = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() };
  await handleWorkToolRoute(request as unknown as IncomingMessage, response as unknown as ServerResponse, false);
  expect(response.writeHead.mock.calls[0][0]).toBe(401);
  expect(JSON.parse(response.end.mock.calls[0][0])).toEqual({ error: 'Unauthorized.' });
});
