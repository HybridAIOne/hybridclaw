import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadAppTeamsManifest } from './apps';
import {
  fetchAgentAvatarBlob,
  fetchArtifactBlob,
  synthesizeSpeech,
} from './chat';
import {
  AUTH_REQUIRED_EVENT,
  downloadDistillCorpusDocument,
  downloadMSTeamsOrgManifest,
} from './client';

const signal = new AbortController().signal;

const DOWNLOADS: Array<{
  name: string;
  call: () => Promise<Blob>;
  url: string;
  init: Record<string, unknown>;
}> = [
  {
    name: 'synthesizeSpeech',
    call: () => synthesizeSpeech('test-token', 'Hello there', signal),
    url: '/api/media/speech',
    init: {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello there' }),
      signal,
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
    },
  },
  {
    name: 'fetchArtifactBlob',
    call: () => fetchArtifactBlob('test-token', '/tmp/report.pdf'),
    url: '/api/artifact?path=%2Ftmp%2Freport.pdf',
    init: {
      cache: 'no-store',
      headers: { Authorization: 'Bearer test-token' },
    },
  },
  {
    name: 'fetchAgentAvatarBlob',
    call: () =>
      fetchAgentAvatarBlob('test-token', '/api/agent-avatar?agentId=main'),
    url: '/api/agent-avatar?agentId=main',
    init: {
      cache: 'no-store',
      headers: { Authorization: 'Bearer test-token' },
    },
  },
  {
    name: 'downloadDistillCorpusDocument',
    call: () =>
      downloadDistillCorpusDocument('test-token', {
        alias: 'subject a',
        agentId: ' agent_a ',
        documentId: 'doc/1',
      }),
    url: '/api/admin/distill/corpus/doc%2F1?alias=subject+a&agentId=agent_a',
    init: {
      cache: 'no-store',
      headers: { Authorization: 'Bearer test-token' },
    },
  },
  {
    name: 'downloadMSTeamsOrgManifest',
    call: () => downloadMSTeamsOrgManifest('test-token'),
    url: '/api/admin/msteams/tab-manifest',
    init: { headers: { Authorization: 'Bearer test-token' } },
  },
  {
    name: 'downloadAppTeamsManifest',
    call: () => downloadAppTeamsManifest('test-token', 'app/1'),
    url: '/api/apps/app%2F1/teams-manifest',
    init: { headers: { Authorization: 'Bearer test-token' } },
  },
];

describe('blob downloads', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(DOWNLOADS)(
    '$name sends its request and returns the body',
    async ({ call, url, init }) => {
      vi.mocked(fetch).mockResolvedValue(new Response('payload-bytes'));

      const blob = await call();

      await expect(blob.text()).resolves.toBe('payload-bytes');
      expect(fetch).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = vi.mocked(fetch).mock.calls[0] ?? [];
      expect(calledUrl).toBe(url);
      expect(calledInit).toMatchObject(init);
      expect(calledInit?.method ?? 'GET').toBe(init.method ?? 'GET');
      expect(calledInit?.cache).toBe(init.cache);
    },
  );

  it.each(DOWNLOADS)(
    '$name surfaces the gateway error and asks for auth on 401',
    async ({ call }) => {
      const events: Event[] = [];
      const listener = (event: Event) => events.push(event);
      window.addEventListener(AUTH_REQUIRED_EVENT, listener);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Unauthorized.' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      );

      try {
        await expect(call()).rejects.toThrow('Unauthorized.');
        expect(events).toHaveLength(1);
      } finally {
        window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
      }
    },
  );

  it.each(DOWNLOADS)(
    '$name rejects other failures without an auth prompt',
    async ({ call }) => {
      const events: Event[] = [];
      const listener = (event: Event) => events.push(event);
      window.addEventListener(AUTH_REQUIRED_EVENT, listener);
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ error: 'Not found.' }), { status: 404 }),
      );

      try {
        await expect(call()).rejects.toMatchObject({
          message: 'Not found.',
          status: 404,
        });
        expect(events).toHaveLength(0);
      } finally {
        window.removeEventListener(AUTH_REQUIRED_EVENT, listener);
      }
    },
  );
});
