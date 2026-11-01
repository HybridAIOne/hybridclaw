import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import { useCleanMocks, useTempDir } from './test-utils.js';

const { vision } = vi.hoisted(() => ({
  vision: vi.fn(async () => ({
    model: 'example/vision',
    analysis: 'Fixture analysis.',
  })),
}));
vi.mock('../container/src/providers/auxiliary.js', () => ({
  callAuxiliaryModel: vision,
}));
const temp = useTempDir('hybridclaw-http-artifact-');
useCleanMocks({
  resetModules: true,
  unstubAllEnvs: true,
  cleanup: () => {
    vision.mockClear();
  },
});
const filename = '1234567890-1234abcd-document.txt';

async function fixture(separate: boolean, allowed = true) {
  const state = temp();
  const execution = separate ? temp() : state;
  fs.mkdirSync(path.join(state, '.http-artifacts'));
  fs.writeFileSync(
    path.join(state, '.http-artifacts', filename),
    'Downloaded source content.',
  );
  if (separate) {
    fs.mkdirSync(path.join(execution, '.http-artifacts'));
    fs.writeFileSync(
      path.join(execution, '.http-artifacts', filename),
      'Unrelated project shadow.',
    );
  }
  vi.stubEnv('HYBRIDCLAW_AGENT_WORKSPACE_ROOT', execution);
  vi.stubEnv(
    'HYBRIDCLAW_AGENT_WORKSPACE_DISPLAY_ROOT',
    separate ? execution : '/workspace',
  );
  vi.stubEnv('HYBRIDCLAW_AGENT_STATE_ROOT', state);
  vi.stubEnv(
    'HYBRIDCLAW_AGENT_ALLOWED_ROOTS',
    JSON.stringify(allowed ? [state] : []),
  );
  const { executeToolWithMetadata } = await import('../container/src/tools.js');
  return {
    state,
    execution,
    tools: { executeToolWithMetadata },
    read: (file: string) =>
      executeToolWithMetadata('read', JSON.stringify({ path: file })),
  };
}

test.each([false, true])(
  'HTTP artifact aliases read the saved state file (separate execution: %s)',
  async (separate) => {
    const f = await fixture(separate);
    const result = await f.read(`/workspace/.http-artifacts/${filename}`);
    expect(result.isError).toBe(false);
    expect(result.output).toBe('Downloaded source content.');
    expect(result.output).not.toContain('Unrelated project shadow.');
  },
);

test('relative project files are not captured by the canonical artifact alias', async () => {
  const f = await fixture(true);
  const result = await f.read(`.http-artifacts/${filename}`);
  expect(result.isError).toBe(false);
  expect(result.output).toBe('Unrelated project shadow.');
});

test('the alias does not grant access to an unapproved state root', async () => {
  const f = await fixture(true, false);
  const result = await f.read(`/workspace/.http-artifacts/${filename}`);
  expect(result.isError).toBe(true);
  expect(result.output).not.toContain('Downloaded source content.');
});

test.each(['file', 'directory', 'traversal'])(
  'the alias rejects %s escapes',
  async (kind) => {
    const f = await fixture(true);
    const outside = temp();
    fs.writeFileSync(path.join(outside, filename), 'Outside artifact cache.');
    let request = `/workspace/.http-artifacts/${filename}`;
    if (kind === 'file') {
      fs.unlinkSync(path.join(f.state, '.http-artifacts', filename));
      fs.symlinkSync(
        path.join(outside, filename),
        path.join(f.state, '.http-artifacts', filename),
      );
    } else if (kind === 'directory') {
      fs.rmSync(path.join(f.state, '.http-artifacts'), { recursive: true });
      fs.symlinkSync(outside, path.join(f.state, '.http-artifacts'), 'dir');
    } else {
      request = '/workspace/.http-artifacts/../private.txt';
    }
    const result = await f.read(request);
    expect(result.isError).toBe(true);
    expect(result.output).not.toContain('Outside artifact cache.');
  },
);

test('write does not inherit the read-only alias', async () => {
  const f = await fixture(true);
  const result = await f.tools.executeToolWithMetadata(
    'write',
    JSON.stringify({
      path: `/workspace/.http-artifacts/${filename}`,
      contents: 'Replacement',
    }),
  );
  expect(result.isError).toBe(true);
  expect(
    fs.readFileSync(path.join(f.state, '.http-artifacts', filename), 'utf8'),
  ).toBe('Downloaded source content.');
});

test('vision analysis reads the same saved artifact instead of a project shadow', async () => {
  const f = await fixture(true);
  const name = '1234567890-1234abcd-picture.png';
  const bytes = Buffer.from('89504e470d0a1a0a', 'hex');
  fs.writeFileSync(path.join(f.state, '.http-artifacts', name), bytes);
  fs.writeFileSync(
    path.join(f.execution, '.http-artifacts', name),
    'Project shadow',
  );
  const { setMediaContext } = await import('../container/src/tools.js');
  setMediaContext([], [], true);
  const result = await f.tools.executeToolWithMetadata(
    'vision_analyze',
    JSON.stringify({
      image_url: `/workspace/.http-artifacts/${name}`,
      question: 'Describe the image.',
    }),
  );
  expect(result.isError).toBe(false);
  expect(vision).toHaveBeenCalledWith(
    expect.objectContaining({
      imageDataUrl: `data:image/png;base64,${bytes.toString('base64')}`,
    }),
  );
});
