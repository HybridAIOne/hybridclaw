import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// config.example.json is DEFAULT_RUNTIME_CONFIG plus EXAMPLE_OVERLAY, never
// edited by hand. The overlay may only replace keys the defaults define (or
// fill an empty map such as `mcpServers`), so a renamed or removed config key
// fails generation instead of lingering in the example.

// Importing the runtime schema also loads secret-store helpers. Point those
// helpers at an isolated, non-existent temp directory so generation never
// inspects or chmods an operator's real runtime home.
const ISOLATED_DATA_DIR = '/tmp/hybridclaw-runtime-home';
process.env.HYBRIDCLAW_DATA_DIR = ISOLATED_DATA_DIR;

const { DEFAULT_RUNTIME_CONFIG } = await import(
  '../src/config/runtime-config.js'
);

// Example values that differ from the defaults on purpose: machine-specific
// paths replaced by portable ones, and disabled sample entries that show the
// shape of optional sections.
const EXAMPLE_OVERLAY = {
  signal: { daemonUrl: 'http://127.0.0.1:8080' },
  imessage: { dbPath: '/Users/example/Library/Messages/chat.db' },
  mcpServers: {
    filesystem: {
      transport: 'stdio',
      command: 'npx',
      args: [
        '-y',
        '@modelcontextprotocol/server-filesystem',
        '/absolute/path/to/a/workspace',
      ],
      enabled: false,
    },
    tavily: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'tavily-mcp@latest'],
      env: { TAVILY_API_KEY: 'replace-me' },
      enabled: false,
    },
    playwright: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@latest'],
      enabled: false,
    },
    linear: {
      transport: 'http',
      url: 'https://mcp.linear.app/mcp',
      auth: 'oauth',
      enabled: false,
    },
  },
  ops: { dbPath: '~/.hybridclaw/data/hybridclaw.db' },
};

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function applyOverlay(
  base: JsonRecord,
  overlay: JsonRecord,
  pathParts: string[],
): void {
  for (const [key, value] of Object.entries(overlay)) {
    const keyPath = [...pathParts, key].join('.');
    if (
      key === '__proto__' ||
      key === 'constructor' ||
      !Object.hasOwn(base, key)
    ) {
      throw new Error(
        `Example overlay key \`${keyPath}\` is not in DEFAULT_RUNTIME_CONFIG.`,
      );
    }
    const current = base[key];
    if (isRecord(current) && Object.keys(current).length > 0) {
      if (!isRecord(value)) {
        throw new Error(
          `Example overlay key \`${keyPath}\` must be an object.`,
        );
      }
      applyOverlay(current, value, [...pathParts, key]);
    } else {
      base[key] = value;
    }
  }
}

function assertPortable(value: unknown, pathParts: string[]): void {
  if (typeof value === 'string') {
    if (
      value.startsWith(ISOLATED_DATA_DIR) ||
      value.startsWith(`${os.homedir()}${path.sep}`)
    ) {
      throw new Error(
        `Default \`${pathParts.join('.')}\` is machine-specific; add a portable value to EXAMPLE_OVERLAY.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      assertPortable(item, [...pathParts, String(index)]);
    });
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertPortable(child, [...pathParts, key]);
    }
  }
}

const example = structuredClone(
  DEFAULT_RUNTIME_CONFIG,
) as unknown as JsonRecord;
applyOverlay(example, EXAMPLE_OVERLAY, []);
assertPortable(example, []);

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const outputPath = path.join(repoRoot, 'config.example.json');

if (process.argv.includes('--check')) {
  // Compare values, not bytes: Biome owns the file's formatting.
  const current = fs.existsSync(outputPath)
    ? JSON.stringify(JSON.parse(fs.readFileSync(outputPath, 'utf-8')))
    : null;
  if (current !== JSON.stringify(example)) {
    console.error(
      'config.example.json is stale. Run `npm run generate:config-example`.',
    );
    process.exitCode = 1;
  }
} else {
  fs.writeFileSync(outputPath, `${JSON.stringify(example, null, 2)}\n`);
  execFileSync('npx', ['biome', 'format', '--write', outputPath], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  console.log(`Generated ${path.relative(repoRoot, outputPath)}.`);
}
