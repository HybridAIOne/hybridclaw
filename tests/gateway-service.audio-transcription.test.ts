import fs from 'node:fs';
import path from 'node:path';

import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.ts';

const { runAgentMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
}));

vi.mock('../src/agent/agent.js', () => ({
  runAgent: runAgentMock,
}));

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const ORIGINAL_GROQ_API_KEY = process.env.GROQ_API_KEY;
const ORIGINAL_WHISPER_CPP_MODEL = process.env.WHISPER_CPP_MODEL;
const ORIGINAL_PATH = process.env.PATH;

const makeTempHome = useTempDir('hybridclaw-audio-home-');
const makeTempDir = useTempDir();

function restoreEnvVar(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

useCleanMocks({
  restoreAllMocks: true,
  cleanup: () => {
    runAgentMock.mockReset();
    restoreEnvVar('HOME', ORIGINAL_HOME);
    restoreEnvVar('OPENAI_API_KEY', ORIGINAL_OPENAI_API_KEY);
    restoreEnvVar('GROQ_API_KEY', ORIGINAL_GROQ_API_KEY);
    restoreEnvVar('WHISPER_CPP_MODEL', ORIGINAL_WHISPER_CPP_MODEL);
    restoreEnvVar('PATH', ORIGINAL_PATH);
  },
  resetModules: true,
  unstubAllGlobals: true,
});

async function createGatewayAudioFixture() {
  const homeDir = makeTempHome();
  process.env.HOME = homeDir;
  vi.resetModules();

  runAgentMock.mockResolvedValue({
    status: 'success',
    result: 'agent result',
    toolsUsed: [],
    toolExecutions: [],
  });

  const { initDatabase } = await import('../src/memory/db.ts');
  initDatabase({ quiet: true });

  const { DATA_DIR } = await import('../src/config/config.ts');
  const { updateRuntimeConfig } = await import(
    '../src/config/runtime-config.ts'
  );
  const { handleGatewayMessage } = await import(
    '../src/gateway/gateway-chat-service.ts'
  );
  const { memoryService } = await import('../src/memory/memory-service.ts');

  const relativeAudioPath = '/discord-media-cache/2026-03-12/voice-note.ogg';
  const hostAudioPath = path.join(
    DATA_DIR,
    'discord-media-cache',
    '2026-03-12',
    'voice-note.ogg',
  );
  fs.mkdirSync(path.dirname(hostAudioPath), { recursive: true });
  fs.writeFileSync(hostAudioPath, 'voice-bytes', 'utf-8');

  return {
    handleGatewayMessage,
    memoryService,
    relativeAudioPath,
    updateRuntimeConfig,
  };
}

test('handleGatewayMessage prepends audio transcripts and preserves media context', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const fetchMock = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    expect(headers.get('authorization')).toBe('Bearer test-openai-key');
    expect(init?.body).toBeInstanceOf(FormData);
    const form = init?.body as FormData;
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('response_format')).toBe('json');
    return {
      ok: true,
      headers: {
        get() {
          return 'application/json';
        },
      },
      json: async () => ({ text: 'hello from the voice note' }),
      text: async () => '',
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  const fixture = await createGatewayAudioFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.media.audio.models = [{ type: 'provider', provider: 'openai' }];
  });
  const sessionId = 'discord:audio-transcription';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    userId: 'user-1',
    username: 'user',
    content: 'please summarize this',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: fixture.relativeAudioPath,
        url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        originalUrl:
          'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        media?: Array<{ path: string | null }>;
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  expect(request?.media).toEqual([
    expect.objectContaining({
      path: fixture.relativeAudioPath,
    }),
  ]);

  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.role).toBe('user');
  expect(userMessage?.content).toContain('[AudioTranscript]');
  expect(request?.audioTranscriptsPrepended).toBe(true);
  expect(userMessage?.content).toContain('1. voice-note.ogg (audio/ogg):');
  expect(userMessage?.content).toContain('hello from the voice note');
  expect(userMessage?.content).toContain('please summarize this');
  expect(userMessage?.content).toContain(
    `AudioMediaPaths: ["${fixture.relativeAudioPath}"]`,
  );

  const history = fixture.memoryService.getConversationHistory(sessionId, 10);
  expect(
    history.some((message) =>
      message.content.includes('hello from the voice note'),
    ),
  ).toBe(true);
});

test('handleGatewayMessage continues without transcript when audio transcription fails', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 500,
    headers: {
      get(name: string) {
        return name === 'content-type' ? 'application/json' : null;
      },
    },
    json: async () => ({
      error: {
        message: 'transcription failed',
      },
    }),
    text: async () => '',
  }));
  vi.stubGlobal('fetch', fetchMock);

  const fixture = await createGatewayAudioFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.media.audio.models = [{ type: 'provider', provider: 'openai' }];
  });
  const sessionId = 'discord:audio-transcription-error';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    userId: 'user-1',
    username: 'user',
    content: 'keep going',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: fixture.relativeAudioPath,
        url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        originalUrl:
          'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.content).not.toContain('[AudioTranscript]');
  expect(request?.audioTranscriptsPrepended).toBe(false);
  expect(userMessage?.content).toContain('keep going');
  expect(userMessage?.content).toContain(
    `AudioMediaPaths: ["${fixture.relativeAudioPath}"]`,
  );

  const history = fixture.memoryService.getConversationHistory(sessionId, 10);
  expect(
    history.some((message) => message.content.includes('keep going')),
  ).toBe(true);
  expect(
    history.some((message) => message.content.includes('transcription failed')),
  ).toBe(false);
});

test('handleGatewayMessage prefers local CLI transcription before OpenAI when auto-detecting', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const binDir = makeTempDir('hybridclaw-whisper-bin-');
  const whisperPath = path.join(binDir, 'whisper');
  fs.writeFileSync(
    whisperPath,
    [
      '#!/bin/sh',
      'out_dir=""',
      'input_path=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output_dir)',
      '      out_dir="$2"',
      '      shift 2',
      '      ;;',
      '    --model|--output_format|--verbose)',
      '      shift 2',
      '      ;;',
      '    *)',
      '      input_path="$1"',
      '      shift',
      '      ;;',
      '  esac',
      'done',
      'base="$(basename "$input_path")"',
      `base="\${base%.*}"`,
      'printf "local whisper transcript\\n" > "$out_dir/$base.txt"',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(whisperPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH || ''}`;

  const fixture = await createGatewayAudioFixture();
  const sessionId = 'discord:audio-transcription-local-first';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    userId: 'user-1',
    username: 'user',
    content: 'reply to this voice note',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: fixture.relativeAudioPath,
        url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        originalUrl:
          'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.content).toContain('local whisper transcript');
  expect(request?.audioTranscriptsPrepended).toBe(true);
});

test('handleGatewayMessage transcribes with a local CLI when no provider key is configured', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const binDir = makeTempDir('hybridclaw-whisper-local-bin-');
  const whisperPath = path.join(binDir, 'whisper');
  fs.writeFileSync(
    whisperPath,
    [
      '#!/bin/sh',
      'out_dir=""',
      'input_path=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    --output_dir)',
      '      out_dir="$2"',
      '      shift 2',
      '      ;;',
      '    --model|--output_format|--verbose)',
      '      shift 2',
      '      ;;',
      '    *)',
      '      input_path="$1"',
      '      shift',
      '      ;;',
      '  esac',
      'done',
      'base="$(basename "$input_path")"',
      `base="\${base%.*}"`,
      'printf "local-only transcript\\n" > "$out_dir/$base.txt"',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(whisperPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH || ''}`;

  const fixture = await createGatewayAudioFixture();
  const sessionId = 'discord:audio-transcription-local-only';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    userId: 'user-1',
    username: 'user',
    content: 'reply without cloud keys',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: fixture.relativeAudioPath,
        url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        originalUrl:
          'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).not.toHaveBeenCalled();

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.content).toContain('local-only transcript');
  expect(request?.audioTranscriptsPrepended).toBe(true);
});

test('handleGatewayMessage transcribes managed WhatsApp temp audio with whisper-cli', async () => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.GROQ_API_KEY;
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);

  const binDir = makeTempDir('hybridclaw-whisper-cli-bin-');
  const modelDir = makeTempDir('hybridclaw-whisper-cli-model-');
  const modelPath = path.join(modelDir, 'ggml-tiny.bin');
  fs.writeFileSync(modelPath, 'fake-model', 'utf-8');
  process.env.WHISPER_CPP_MODEL = modelPath;

  const whisperCliPath = path.join(binDir, 'whisper-cli');
  fs.writeFileSync(
    whisperCliPath,
    [
      '#!/bin/sh',
      'out_base=""',
      'while [ "$#" -gt 0 ]; do',
      '  case "$1" in',
      '    -of)',
      '      out_base="$2"',
      '      shift 2',
      '      ;;',
      '    *)',
      '      shift',
      '      ;;',
      '  esac',
      'done',
      'printf "whatsapp whisper transcript\\n" > "${out_base}.txt"',
      '',
    ].join('\n'),
    'utf-8',
  );
  fs.chmodSync(whisperCliPath, 0o755);
  process.env.PATH = `${binDir}${path.delimiter}${ORIGINAL_PATH || ''}`;

  const waTempDir = makeTempDir('hybridclaw-wa-');
  const waAudioPath = path.join(waTempDir, 'voice-note.ogg');
  fs.writeFileSync(waAudioPath, 'voice-bytes', 'utf-8');

  const fixture = await createGatewayAudioFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.media.audio.models = [
      {
        type: 'cli',
        command: 'whisper-cli',
        args: [
          '-m',
          modelPath,
          '-otxt',
          '-of',
          '{{OutputBase}}',
          '-np',
          '-nt',
          '{{MediaPath}}',
        ],
      },
    ];
  });
  const sessionId = 'whatsapp:audio-transcription-whisper-cli';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: null,
    channelId: '1061007917075@lid',
    userId: '+491703330161',
    username: 'Benedikt',
    content: '',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: waAudioPath,
        url: `file://${waAudioPath}`,
        originalUrl: `file://${waAudioPath}`,
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(runAgentMock).toHaveBeenCalledTimes(1);

  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.content).toContain('[AudioTranscript]');
  expect(request?.audioTranscriptsPrepended).toBe(true);
  expect(userMessage?.content).toContain('whatsapp whisper transcript');
});

test('handleGatewayMessage falls back to the next configured provider when the first one fails', async () => {
  process.env.OPENAI_API_KEY = 'test-openai-key';
  process.env.GROQ_API_KEY = 'test-groq-key';
  const fetchMock = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      return {
        ok: false,
        status: 500,
        headers: {
          get(name: string) {
            return name === 'content-type' ? 'application/json' : null;
          },
        },
        json: async () => ({
          error: {
            message: 'openai down',
          },
        }),
        text: async () => '',
      };
    }
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    return {
      ok: true,
      headers: {
        get() {
          return 'application/json';
        },
      },
      json: async () => ({ text: 'groq transcript' }),
      text: async () => '',
    };
  });
  vi.stubGlobal('fetch', fetchMock);

  const fixture = await createGatewayAudioFixture();
  fixture.updateRuntimeConfig((draft) => {
    draft.media.audio.models = [
      { type: 'provider', provider: 'openai' },
      { type: 'provider', provider: 'groq' },
    ];
  });
  const sessionId = 'discord:audio-transcription-provider-fallback';

  const result = await fixture.handleGatewayMessage({
    sessionId,
    guildId: 'guild-1',
    channelId: 'discord-channel-1',
    userId: 'user-1',
    username: 'user',
    content: 'keep trying',
    model: 'openai-codex/gpt-5-codex',
    chatbotId: '',
    media: [
      {
        path: fixture.relativeAudioPath,
        url: 'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        originalUrl:
          'https://cdn.discordapp.com/attachments/1/2/voice-note.ogg',
        mimeType: 'audio/ogg; codecs=opus',
        sizeBytes: 11,
        filename: 'voice-note.ogg',
      },
    ],
  });

  expect(result.status).toBe('success');
  expect(fetchMock).toHaveBeenCalledTimes(2);
  const request = runAgentMock.mock.calls[0]?.[0] as
    | {
        messages?: Array<{ role: string; content: string }>;
        audioTranscriptsPrepended?: boolean;
      }
    | undefined;
  const userMessage = request?.messages?.at(-1);
  expect(userMessage?.content).toContain('groq transcript');
  expect(request?.audioTranscriptsPrepended).toBe(true);
});
