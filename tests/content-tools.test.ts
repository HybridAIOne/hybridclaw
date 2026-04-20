import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const ORIGINAL_WORKSPACE_ROOT = process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT;
const ORIGINAL_WORKSPACE_DISPLAY_ROOT =
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT;
const ORIGINAL_MEDIA_ROOT = process.env.HYBRIDCLAW_AGENT_MEDIA_ROOT;
const ORIGINAL_UPLOADED_MEDIA_ROOT =
  process.env.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hybridclaw-content-tools-'));
}

async function loadContentToolsModule(workspaceRoot: string) {
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
  process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
  process.env.HYBRIDCLAW_AGENT_MEDIA_ROOT = path.join(workspaceRoot, '.media');
  process.env.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT = path.join(
    workspaceRoot,
    '.uploaded-media',
  );
  vi.resetModules();
  return await import('../container/src/content-tools.js');
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
  restoreEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', ORIGINAL_WORKSPACE_ROOT);
  restoreEnv(
    'HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT',
    ORIGINAL_WORKSPACE_DISPLAY_ROOT,
  );
  restoreEnv('HYBRIDCLAW_AGENT_MEDIA_ROOT', ORIGINAL_MEDIA_ROOT);
  restoreEnv(
    'HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT',
    ORIGINAL_UPLOADED_MEDIA_ROOT,
  );
});

describe('content tools', () => {
  test('runImageGenerateTool downloads and saves generated images', async () => {
    const workspaceRoot = makeWorkspace();
    const { runImageGenerateTool } =
      await loadContentToolsModule(workspaceRoot);
    const fetchMock = vi.fn(async (url: string) => {
      if (url === 'https://fal.run/fal-ai/flux-2/klein/9b') {
        return new Response(
          JSON.stringify({
            images: [{ url: 'https://cdn.example.com/generated.png' }],
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }
      if (url === 'https://cdn.example.com/generated.png') {
        return new Response(Buffer.from([1, 2, 3, 4]), {
          status: 200,
          headers: { 'Content-Type': 'image/png' },
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const summary = await runImageGenerateTool({
      args: {
        prompt: 'A launch poster',
        output_dir: '.generated-content/images',
      },
      config: {
        apiKey: 'fal-secret',
        baseUrl: 'https://fal.run',
        defaultModel: 'fal-ai/flux-2/klein/9b',
        defaultCount: 1,
        defaultAspectRatio: '1:1',
        defaultResolution: '1K',
        defaultOutputFormat: 'png',
        timeoutMs: 120000,
      },
    });

    const outputDir = path.join(workspaceRoot, '.generated-content', 'images');
    const files = fs.readdirSync(outputDir);
    expect(files).toHaveLength(1);
    expect(summary).toContain('Generated 1 image with fal-ai/flux-2/klein/9b.');
    expect(summary).toContain('/workspace/.generated-content/images/');
  });

  test('runTextToSpeechTool writes synthesized audio to the requested output path', async () => {
    const workspaceRoot = makeWorkspace();
    const { runTextToSpeechTool } = await loadContentToolsModule(workspaceRoot);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(Buffer.from('audio-bytes'), {
            status: 200,
            headers: { 'Content-Type': 'audio/mpeg' },
          }),
      ),
    );

    const summary = await runTextToSpeechTool({
      args: {
        text: 'HybridClaw ships this week.',
        output_path: 'voiceovers/launch.mp3',
      },
      config: {
        apiKey: 'openai-secret',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o-mini-tts',
        defaultVoice: 'alloy',
        defaultOutputFormat: 'mp3',
        defaultSpeed: 1,
        maxChars: 4000,
        timeoutMs: 60000,
      },
    });

    const outputPath = path.join(workspaceRoot, 'voiceovers', 'launch.mp3');
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe('audio-bytes');
    expect(summary).toBe(
      'Synthesized speech with gpt-4o-mini-tts to /workspace/voiceovers/launch.mp3.',
    );
  });

  test('runAudioTranscribeTool returns transcript text for workspace audio files', async () => {
    const workspaceRoot = makeWorkspace();
    const { runAudioTranscribeTool } =
      await loadContentToolsModule(workspaceRoot);
    const audioDir = path.join(workspaceRoot, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'clip.wav'), 'wav-bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ text: 'Transcript body' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const transcript = await runAudioTranscribeTool({
      args: {
        audio_path: 'audio/clip.wav',
      },
      config: {
        apiKey: 'openai-secret',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'whisper-1',
        defaultLanguage: '',
        defaultPrompt: '',
        maxBytes: 25000000,
        timeoutMs: 120000,
      },
      mediaContext: [],
    });

    expect(transcript).toBe(
      'Transcript from clip.wav (whisper-1):\nTranscript body',
    );
  });

  test('runDiagramCreateTool strips code fences and saves Mermaid output', async () => {
    const workspaceRoot = makeWorkspace();
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_ROOT = workspaceRoot;
    process.env.HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT = '/workspace';
    process.env.HYBRIDCLAW_AGENT_MEDIA_ROOT = path.join(
      workspaceRoot,
      '.media',
    );
    process.env.HYBRIDCLAW_AGENT_UPLOADED_MEDIA_ROOT = path.join(
      workspaceRoot,
      '.uploaded-media',
    );
    vi.resetModules();
    vi.doMock('../container/src/providers/router.js', () => ({
      callRoutedModel: vi.fn(async () => ({
        choices: [
          {
            message: {
              content:
                '```mermaid\nflowchart TD\n  A[Prompt] --> B[Diagram]\n```',
            },
          },
        ],
      })),
      extractResponseTextContent: (content: unknown) =>
        typeof content === 'string' ? content : '',
    }));
    const { runDiagramCreateTool } = await import(
      '../container/src/content-tools.js'
    );

    const summary = await runDiagramCreateTool({
      args: {
        prompt: 'Show how a prompt becomes a diagram',
        output_path: 'diagrams/flow.mmd',
      },
      modelContext: {
        provider: 'hybridai',
        baseUrl: 'https://hybridai.one',
        apiKey: 'api-key',
        model: 'gpt-5.4-mini',
        chatbotId: 'bot',
      },
    });

    const outputPath = path.join(workspaceRoot, 'diagrams', 'flow.mmd');
    expect(fs.readFileSync(outputPath, 'utf-8')).toBe(
      'flowchart TD\n  A[Prompt] --> B[Diagram]',
    );
    expect(summary).toContain(
      'Saved Mermaid diagram to /workspace/diagrams/flow.mmd.',
    );
    expect(summary).toContain('flowchart TD');
  });
});
