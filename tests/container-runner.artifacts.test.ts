import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test } from 'vitest';

import {
  type BrowserFrameSink,
  remapOutputArtifacts,
  stashBrowserFrameLine,
  stashSlideSamplesLine,
  takeBrowserFrame,
  takeSlideSamples,
} from '../src/infra/container-runner.js';
import type { ContainerOutput } from '../src/types/container.js';

test('remaps artifact paths that use a custom workspace display root', () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifact-remap-'),
  );
  try {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
      artifacts: [
        {
          path: '/app/output.pdf',
          filename: 'output.pdf',
          mimeType: 'application/pdf',
        },
      ],
    };

    remapOutputArtifacts(output, workspacePath, '/app');

    expect(output.artifacts).toEqual([
      {
        path: path.join(workspacePath, 'output.pdf'),
        filename: 'output.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('prefers the longest matching workspace display root when remapping', () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-artifact-remap-'),
  );
  try {
    const output: ContainerOutput = {
      status: 'success',
      result: 'ok',
      toolsUsed: [],
      artifacts: [
        {
          path: '/workspace/sub/output.pdf',
          filename: 'output.pdf',
          mimeType: 'application/pdf',
        },
      ],
    };

    remapOutputArtifacts(output, workspacePath, '/workspace/sub');

    expect(output.artifacts).toEqual([
      {
        path: path.join(workspacePath, 'output.pdf'),
        filename: 'output.pdf',
        mimeType: 'application/pdf',
      },
    ]);
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('preserves host artifact paths when the real workspace already lives under /workspace', () => {
  // No filesystem setup is needed here because remapOutputArtifacts only
  // normalizes and resolves the path string; it does not stat the workspace.
  const workspacePath = '/workspace/.data/data/agents/main/workspace';
  const output: ContainerOutput = {
    status: 'success',
    result: 'ok',
    toolsUsed: [],
    artifacts: [
      {
        path: '/workspace/.data/data/agents/main/workspace/output.pdf',
        filename: 'output.pdf',
        mimeType: 'application/pdf',
      },
    ],
  };

  remapOutputArtifacts(output, workspacePath);

  expect(output.artifacts).toEqual([
    {
      path: '/workspace/.data/data/agents/main/workspace/output.pdf',
      filename: 'output.pdf',
      mimeType: 'application/pdf',
    },
  ]);
});

test('attaches a browser frame, with its host path, to the next browser result', () => {
  const workspacePath = fs.mkdtempSync(
    path.join(os.tmpdir(), 'hybridclaw-browser-frame-'),
  );
  try {
    const entry: BrowserFrameSink = {
      browserFrameWorkspace: { path: workspacePath },
    };
    expect(stashBrowserFrameLine(entry, '[tool] browser_click: {}')).toBe(
      false,
    );
    expect(
      stashBrowserFrameLine(
        entry,
        '[browser-frame] {"url":"https://shop.example/checkout","title":"Checkout","frame":".browser-artifacts/frames/frame-1.jpg"}',
      ),
    ).toBe(true);

    expect(takeBrowserFrame(entry, 'browser_click', 'start')).toBeUndefined();
    expect(takeBrowserFrame(entry, 'web_fetch', 'finish')).toBeUndefined();
    expect(takeBrowserFrame(entry, 'browser_click', 'finish')).toEqual({
      url: 'https://shop.example/checkout',
      title: 'Checkout',
      frame: path.join(workspacePath, '.browser-artifacts/frames/frame-1.jpg'),
    });
    expect(takeBrowserFrame(entry, 'browser_click', 'finish')).toBeUndefined();
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
});

test('carries a sign-in ask to the sign-in tool\'s finish event', () => {
  const entry: BrowserFrameSink = {};
  expect(
    stashBrowserFrameLine(
      entry,
      '[browser-frame] {"url":"https://hybridai.one/login","title":"Login","signIn":{"host":"hybridai.one"}}',
    ),
  ).toBe(true);

  expect(takeBrowserFrame(entry, 'browser_sign_in', 'finish')).toEqual({
    url: 'https://hybridai.one/login',
    title: 'Login',
    signIn: { host: 'hybridai.one' },
  });
});

test('drops a browser frame path that leaves the workspace', () => {
  const entry: BrowserFrameSink = {
    browserFrameWorkspace: { path: '/srv/agents/main/workspace' },
  };
  stashBrowserFrameLine(
    entry,
    '[browser-frame] {"url":"https://shop.example/","title":"Shop","frame":"../../secrets.jpg"}',
  );
  expect(takeBrowserFrame(entry, 'browser_navigate', 'finish')).toEqual({
    url: 'https://shop.example/',
    title: 'Shop',
  });
});

test('attaches sample slides, with host paths, to the slide samples result', () => {
  const entry: BrowserFrameSink = {
    browserFrameWorkspace: { path: '/srv/agents/hy/workspace' },
  };
  expect(
    stashSlideSamplesLine(
      entry,
      '[slide-samples] {"question":"Which look?","looks":[{"title":"Calm","note":"Light","image":".slide-samples/1/look-1.png"},{"title":"Bold","image":".slide-samples/1/look-2.png"}],"formats":["powerpoint","google_slides"]}',
    ),
  ).toBe(true);

  expect(takeSlideSamples(entry, 'bash', 'finish')).toBeUndefined();
  expect(takeSlideSamples(entry, 'show_slide_samples', 'finish')).toEqual({
    question: 'Which look?',
    looks: [
      {
        title: 'Calm',
        note: 'Light',
        image: '/srv/agents/hy/workspace/.slide-samples/1/look-1.png',
      },
      {
        title: 'Bold',
        image: '/srv/agents/hy/workspace/.slide-samples/1/look-2.png',
      },
    ],
    formats: ['powerpoint', 'google_slides'],
  });
  expect(
    takeSlideSamples(entry, 'show_slide_samples', 'finish'),
  ).toBeUndefined();
});

test('drops sample slides when a picture leaves the workspace', () => {
  const entry: BrowserFrameSink = {
    browserFrameWorkspace: { path: '/srv/agents/hy/workspace' },
  };
  stashSlideSamplesLine(
    entry,
    '[slide-samples] {"looks":[{"title":"Calm","image":".slide-samples/1/look-1.png"},{"title":"Bold","image":"../../secrets.png"}]}',
  );
  expect(
    takeSlideSamples(entry, 'show_slide_samples', 'finish'),
  ).toBeUndefined();
});
