import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { expect, test, vi } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '..');
const GATEWAY_ENTRY = path.join(ROOT, 'src/gateway/gateway.ts');

// Optional-channel and platform-specific SDKs: each costs 5-20 MB of heap in
// every gateway, so they load through `channel-runtime-loaders.ts` or on
// their own feature path, never from the startup graph.
const LAZY_ONLY_PACKAGES = [
  '@modelcontextprotocol/sdk',
  '@slack/bolt',
  '@slack/web-api',
  'botbuilder',
  'botbuilder-core',
  'botframework-connector',
  'botframework-schema',
  'discord.js',
  'imapflow',
  'mailparser',
  'nodemailer',
];

const STATIC_IMPORT_RE =
  /^\s*(?:import|export)\s(?:[^'"`;]*?\sfrom\s)?\s*['"]([^'"]+)['"]/gm;

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of [base.replace(/\.js$/, '.ts'), base]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

// Transpiling drops type-only imports the same way tsc does, so the walk sees
// exactly the modules Node loads at startup.
function collectStartupPackages(entry: string): Map<string, string> {
  const importers = new Map<string, string>();
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = fs.readFileSync(file, 'utf8');
    const output = file.endsWith('.ts')
      ? ts.transpileModule(source, {
          compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
          },
        }).outputText
      : source;
    for (const [, specifier] of output.matchAll(STATIC_IMPORT_RE)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        const name = packageName(specifier);
        if (!importers.has(name)) importers.set(name, path.relative(ROOT, file));
        continue;
      }
      const resolved = resolveLocal(file, specifier);
      if (resolved && !seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return importers;
}

test('gateway startup graph does not statically load optional channel SDKs', () => {
  const importers = collectStartupPackages(GATEWAY_ENTRY);

  // Sanity check that the walk reaches real dependencies.
  expect(importers.has('better-sqlite3')).toBe(true);
  const leaked = LAZY_ONLY_PACKAGES.filter((name) => importers.has(name)).map(
    (name) => `${name} (imported by ${importers.get(name)})`,
  );
  expect(leaked).toEqual([]);
});

test('channel runtime loaders expose a module only after it is loaded', async () => {
  vi.resetModules();
  vi.doMock('../src/channels/slack/runtime.js', () => ({
    shutdownSlack: vi.fn(),
  }));
  try {
    const { slackRuntime } = await import(
      '../src/channels/channel-runtime-loaders.js'
    );

    expect(slackRuntime.current()).toBeNull();
    const loaded = await slackRuntime.load();
    expect(slackRuntime.current()).toBe(loaded);
    expect(await slackRuntime.load()).toBe(loaded);
  } finally {
    vi.doUnmock('../src/channels/slack/runtime.js');
  }
});
