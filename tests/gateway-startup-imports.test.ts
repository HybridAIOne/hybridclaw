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

function valueIdentifiers(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) ||
      ts.isTypeNode(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      (ts.isHeritageClause(node) &&
        node.token === ts.SyntaxKind.ImplementsKeyword)
    ) {
      return;
    }
    if (ts.isPropertyAccessExpression(node)) {
      visit(node.expression);
      return;
    }
    if (ts.isIdentifier(node)) names.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

// Mirrors tsc's import elision: a TS import survives only if one of its
// bindings is used outside type positions. Over-counting only fails loudly.
function runtimeImportSpecifiers(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022);
  const elides = file.endsWith('.ts');
  const used = elides ? valueIdentifiers(sourceFile) : new Set<string>();
  const specifiers: string[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = (statement.moduleSpecifier as ts.StringLiteral).text;
      const clause = statement.importClause;
      if (!clause || !elides) {
        specifiers.push(specifier);
        continue;
      }
      if (clause.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      const bindings: string[] = [];
      if (clause.name) bindings.push(clause.name.text);
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) bindings.push(named.name.text);
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (!element.isTypeOnly) bindings.push(element.name.text);
        }
      }
      if (bindings.some((binding) => used.has(binding))) {
        specifiers.push(specifier);
      }
    } else if (
      ts.isExportDeclaration(statement) &&
      statement.moduleSpecifier &&
      !statement.isTypeOnly
    ) {
      const elements =
        statement.exportClause && ts.isNamedExports(statement.exportClause)
          ? statement.exportClause.elements
          : null;
      if (!elements || elements.some((element) => !element.isTypeOnly)) {
        specifiers.push((statement.moduleSpecifier as ts.StringLiteral).text);
      }
    }
  }
  return specifiers;
}

function collectStartupPackages(entry: string): {
  importers: Map<string, string>;
  unresolved: string[];
} {
  const importers = new Map<string, string>();
  const unresolved: string[] = [];
  const seen = new Set([entry]);
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    const source = fs.readFileSync(file, 'utf8');
    for (const specifier of runtimeImportSpecifiers(file, source)) {
      if (specifier.startsWith('node:')) continue;
      if (!specifier.startsWith('.')) {
        const name = packageName(specifier);
        if (!importers.has(name)) importers.set(name, path.relative(ROOT, file));
        continue;
      }
      const resolved = resolveLocal(file, specifier);
      if (!resolved) {
        unresolved.push(`${path.relative(ROOT, file)} -> ${specifier}`);
      } else if (!seen.has(resolved)) {
        seen.add(resolved);
        queue.push(resolved);
      }
    }
  }
  return { importers, unresolved };
}

test('gateway startup graph does not statically load optional channel SDKs', () => {
  const { importers, unresolved } = collectStartupPackages(GATEWAY_ENTRY);

  expect(unresolved).toEqual([]);
  expect(importers.has('better-sqlite3')).toBe(true);
  const leaked = LAZY_ONLY_PACKAGES.filter((name) => importers.has(name)).map(
    (name) => `${name} (imported by ${importers.get(name)})`,
  );
  expect(leaked).toEqual([]);
});

test('import elision keeps value imports and drops type-only ones', () => {
  const source = [
    "import { AsValue, AsType } from 'pkg-mixed';",
    "import { OnlyType } from 'pkg-type-usage';",
    "import type { Declared } from 'pkg-import-type';",
    "import { type Inline } from 'pkg-inline-type';",
    "import 'pkg-side-effect';",
    "export { reexported } from 'pkg-reexport';",
    "export type { ReexportedType } from 'pkg-reexport-type';",
    'export const value: AsType | OnlyType | Declared | Inline = new AsValue();',
  ].join('\n');

  expect(runtimeImportSpecifiers('example.ts', source)).toEqual([
    'pkg-mixed',
    'pkg-side-effect',
    'pkg-reexport',
  ]);
});

test('channel runtime loaders expose a module only after it is loaded', async () => {
  vi.resetModules();
  vi.doMock('../src/channels/slack/runtime.js', () => ({
    shutdownSlack: vi.fn(),
  }));
  try {
    const { slackRuntimeLoader } = await import(
      '../src/channels/channel-runtime-loaders.js'
    );

    expect(slackRuntimeLoader.current()).toBeNull();
    const loaded = await slackRuntimeLoader.load();
    expect(slackRuntimeLoader.current()).toBe(loaded);
    expect(await slackRuntimeLoader.load()).toBe(loaded);
  } finally {
    vi.doUnmock('../src/channels/slack/runtime.js');
  }
});

test('channel runtime loaders retry after a failed import', async () => {
  vi.resetModules();
  let attempts = 0;
  vi.doMock('../src/channels/email/runtime.js', () => {
    attempts += 1;
    if (attempts === 1) throw new Error('module missing mid-upgrade');
    return { shutdownEmail: vi.fn() };
  });
  try {
    const { emailRuntimeLoader } = await import(
      '../src/channels/channel-runtime-loaders.js'
    );

    await expect(emailRuntimeLoader.load()).rejects.toThrow();
    expect(emailRuntimeLoader.current()).toBeNull();
    await expect(emailRuntimeLoader.load()).resolves.toHaveProperty(
      'shutdownEmail',
    );
  } finally {
    vi.doUnmock('../src/channels/email/runtime.js');
  }
});
