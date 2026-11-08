/**
 * Bounded Python inspection distinguishes data operations, imports and comments.
 * The isolated parser never executes supplied source. Failed inspection keeps
 * the caller's conservative result; comments never authorize executable code.
 * Unlike approval policy, this is syntax inspection, not a Python sandbox.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isRecord } from '../shared/primitive-values.js';
import { type Cwd, resolvePath } from './bash-commands.js';
import {
  isWithinRoot,
  resolveCanonicalPath,
  resolveWorkspacePath,
  WORKSPACE_ROOT,
} from './runtime-paths.js';

// Codex, 2026-11-08: cap untrusted parsing at 32 KiB / 4096 nodes
// and one second. Missing system Python keeps the existing approval path.
const MAX_SOURCE_BYTES = 32 * 1024;
const PARSER_TIMEOUT_MS = 1000;

const PYTHON_INSPECTION = `
import ast, io, json, sys, tokenize

class Unknown(Exception):
    pass

DATA = 'data'
FILE = 'file'
IMAGE = 'image'
PURE = {'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set',
        'sorted', 'enumerate', 'range', 'min', 'max', 'sum', 'abs', 'round'}
METHODS = {'get', 'items', 'keys', 'values', 'strip', 'split', 'splitlines',
           'join', 'lower', 'upper', 'replace'}

class Reader:
    def __init__(self):
        self.names = {}
        self.reserved = PURE | {'open', 'print'}
        self.reads = []
        self.writes = []

    def image_path(self, node, paths):
        if not isinstance(node, ast.Constant) or not isinstance(node.value, str) or not node.value or '\\0' in node.value:
            raise Unknown()
        paths.append(node.value)

    def bind(self, target, kind):
        if isinstance(target, ast.Name):
            if target.id in self.reserved or target.id.startswith('__'):
                raise Unknown()
            self.names[target.id] = kind
        elif isinstance(target, (ast.Tuple, ast.List)) and kind == DATA:
            for item in target.elts:
                self.bind(item, DATA)
        else:
            raise Unknown()

    def data(self, node):
        if self.expr(node) != DATA:
            raise Unknown()

    def args(self, node):
        for arg in node.args:
            self.data(arg)
        for kw in node.keywords:
            if kw.arg is None:
                raise Unknown()
            self.data(kw.value)

    def expr(self, node):
        if isinstance(node, ast.Constant):
            return DATA
        if isinstance(node, ast.Name):
            if self.names.get(node.id) in {DATA, FILE, IMAGE}:
                return self.names[node.id]
        elif isinstance(node, (ast.List, ast.Tuple, ast.Set)):
            for item in node.elts:
                self.data(item)
            return DATA
        elif isinstance(node, ast.Dict):
            for key, value in zip(node.keys, node.values):
                if key is None:
                    raise Unknown()
                self.data(key)
                self.data(value)
            return DATA
        elif isinstance(node, ast.Subscript):
            self.data(node.value)
            self.data(node.slice)
            return DATA
        elif isinstance(node, ast.Slice):
            for part in [node.lower, node.upper, node.step]:
                if part is not None:
                    self.data(part)
            return DATA
        elif isinstance(node, (ast.UnaryOp, ast.BinOp, ast.BoolOp, ast.Compare, ast.IfExp)):
            for child in ast.iter_child_nodes(node):
                if isinstance(child, ast.expr):
                    self.data(child)
            return DATA
        elif isinstance(node, ast.JoinedStr):
            for part in node.values:
                self.data(part)
            return DATA
        elif isinstance(node, ast.FormattedValue):
            self.data(node.value)
            if node.format_spec is not None:
                self.data(node.format_spec)
            return DATA
        elif isinstance(node, ast.Attribute):
            if isinstance(node.value, ast.Name) and self.names.get(node.value.id) == 'sys' and node.attr == 'stdin':
                return FILE
            if node.attr == 'size' and self.expr(node.value) == IMAGE:
                return DATA
        elif isinstance(node, ast.Call):
            return self.call(node)
        raise Unknown()

    def call(self, node):
        fn = node.func
        if isinstance(fn, ast.Name):
            if fn.id == 'open':
                if not 1 <= len(node.args) <= 2:
                    raise Unknown()
                self.data(node.args[0])
                modes = node.args[1:]
                for kw in node.keywords:
                    if kw.arg == 'mode':
                        modes.append(kw.value)
                    elif kw.arg in {'encoding', 'errors', 'newline'}:
                        self.data(kw.value)
                    else:
                        raise Unknown()
                if any(not isinstance(mode, ast.Constant) or mode.value not in {'r', 'rt', 'rb'} for mode in modes):
                    raise Unknown()
                return FILE
            if fn.id in PURE:
                self.args(node)
                return DATA
            if fn.id == 'print':
                if any(kw.arg not in {'sep', 'end', 'flush'} for kw in node.keywords):
                    raise Unknown()
                self.args(node)
                return DATA
        elif isinstance(fn, ast.Attribute):
            if isinstance(fn.value, ast.Name) and self.names.get(fn.value.id) == 'pillow' and fn.attr == 'open':
                if len(node.args) != 1 or node.keywords:
                    raise Unknown()
                self.image_path(node.args[0], self.reads)
                return IMAGE
            if isinstance(fn.value, ast.Name) and self.names.get(fn.value.id) == 'json':
                if len(node.args) != 1 or node.keywords:
                    raise Unknown()
                if fn.attr == 'load' and self.expr(node.args[0]) == FILE:
                    return DATA
                if fn.attr in {'loads', 'dumps'}:
                    self.data(node.args[0])
                    return DATA
            kind = self.expr(fn.value)
            if kind == IMAGE and fn.attr in {'thumbnail', 'save'}:
                if len(node.args) != 1 or node.keywords:
                    raise Unknown()
                if fn.attr == 'save':
                    self.image_path(node.args[0], self.writes)
                else:
                    self.data(node.args[0])
                return DATA
            if (kind == DATA and fn.attr in METHODS) or (kind == FILE and fn.attr in {'read', 'readline', 'readlines', 'close'}):
                self.args(node)
                return DATA
        raise Unknown()

    def statements(self, statements):
        for node in statements:
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname or alias.name
                    if alias.name not in {'json', 'sys'} or name in self.names or name in self.reserved:
                        raise Unknown()
                    self.names[name] = alias.name
                    self.reserved.add(name)
            elif isinstance(node, ast.ImportFrom):
                if node.level or node.module != 'PIL' or len(node.names) != 1 or node.names[0].name != 'Image':
                    raise Unknown()
                name = node.names[0].asname or 'Image'
                if name in self.names or name in self.reserved:
                    raise Unknown()
                self.names[name] = 'pillow'
                self.reserved.add(name)
            elif isinstance(node, ast.Assign):
                kind = self.expr(node.value)
                for target in node.targets:
                    self.bind(target, kind)
            elif isinstance(node, ast.Expr):
                self.expr(node.value)
            elif isinstance(node, ast.For):
                self.data(node.iter)
                self.bind(node.target, DATA)
                self.statements(node.body)
                self.statements(node.orelse)
            elif isinstance(node, ast.If):
                self.data(node.test)
                self.statements(node.body)
                self.statements(node.orelse)
            elif isinstance(node, ast.With):
                for item in node.items:
                    kind = self.expr(item.context_expr)
                    if kind not in {FILE, IMAGE} or item.optional_vars is None:
                        raise Unknown()
                    self.bind(item.optional_vars, kind)
                self.statements(node.body)
            elif not isinstance(node, (ast.Pass, ast.Break, ast.Continue)):
                raise Unknown()

try:
    source = sys.stdin.read()
    encoding, _ = tokenize.detect_encoding(io.BytesIO(source.encode('utf8')).readline)
    if encoding not in {'utf-8', 'utf-8-sig'}:
        raise Unknown()
    tree = ast.parse(source)
    if sum(1 for _ in ast.walk(tree)) > 4096:
        raise Unknown()
    if sys.argv[1] == 'data':
        reader = Reader()
        recognized = True
        try:
            reader.statements(tree.body)
        except Unknown:
            recognized = False
        literals = [node.value for node in ast.walk(tree) if isinstance(node, ast.Constant) and isinstance(node.value, str)]
        imports = []
        sys_names = {'sys'}
        changes_path = False
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imports.extend(alias.name for alias in node.names)
                if any(alias.name.split('.')[0] == 'importlib' for alias in node.names):
                    changes_path = True
                sys_names.update(alias.asname or alias.name for alias in node.names if alias.name == 'sys')
            elif isinstance(node, ast.ImportFrom):
                imports.append(node.module or '')
                imports.extend((node.module + '.' + alias.name) for alias in node.names if node.module)
                if node.module and node.module.split('.')[0] == 'importlib':
                    changes_path = True
                if node.module == 'sys' and any(alias.name != 'stdin' for alias in node.names):
                    changes_path = True
        parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == '__import__' or isinstance(node, ast.Attribute) and node.attr == '__import__':
                changes_path = True
            if isinstance(node, ast.Name) and node.id in sys_names:
                # Only stdin access is certified here; aliases and reflection
                # can restore a directory excluded by isolated startup.
                parent = parents.get(node)
                if not isinstance(parent, ast.Attribute) or parent.attr != 'stdin':
                    changes_path = True
        print(json.dumps({'recognized': recognized, 'reads': reader.reads, 'writes': reader.writes, 'literals': literals, 'imports': imports, 'changesPath': changes_path}))
    elif sys.argv[1] == 'comments':
        lines = source.split('\\n')
        for token in tokenize.generate_tokens(io.StringIO(source).readline):
            if token.type == tokenize.COMMENT:
                row, start = token.start
                end_row, end = token.end
                if row != end_row:
                    raise Unknown()
                line = lines[row - 1]
                lines[row - 1] = line[:start] + ' ' * (end - start) + line[end:]
        print(json.dumps('\\n'.join(lines), ensure_ascii=False))
    else:
        raise Unknown()
except Exception:
    print('unknown')
`;

function inspectPython(
  source: string,
  mode: 'data' | 'comments',
): string | null {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return null;
  const result = spawnSync(
    '/usr/bin/python3',
    ['-I', '-S', '-B', '-c', PYTHON_INSPECTION, mode],
    {
      input: source,
      encoding: 'utf8',
      timeout: PARSER_TIMEOUT_MS,
      maxBuffer: MAX_SOURCE_BYTES * 2 + 32,
      windowsHide: true,
    },
  );
  return result.status === 0 &&
    !result.error &&
    typeof result.stdout === 'string'
    ? result.stdout.trim()
    : null;
}

function canonicalFromExistingAncestor(candidate: string): string | null {
  try {
    for (let current = candidate; ; current = path.dirname(current)) {
      try {
        return path.resolve(
          fs.realpathSync(current),
          path.relative(current, candidate),
        );
      } catch (error) {
        if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          fs.lstatSync(current, { throwIfNoEntry: false }) ||
          path.dirname(current) === current
        )
          return null;
      }
    }
  } catch {
    return null;
  }
}

function isRealWorkspacePath(candidate: string): boolean {
  try {
    const root = fs.realpathSync(WORKSPACE_ROOT);
    const actual = canonicalFromExistingAncestor(candidate);
    return actual !== null && isWithinRoot(actual, root);
  } catch {
    return false;
  }
}

const PYTHON_IMPORTABLE = /\.(?:py[co]?|so|pyd|zip|egg)$/i;

function hasPythonStartupRisk(fetchedFiles: Iterable<string>): boolean {
  // Downloaded importable code may shadow the standard modules this subset
  // uses. Unknown locations cannot establish a data-only interpretation either.
  for (const file of fetchedFiles) {
    if (file.includes('\0') || PYTHON_IMPORTABLE.test(file)) return true;
  }
  return false;
}

export function inspectPythonInline(
  source: string,
  fetchedFiles: Iterable<string>,
  cwd: Cwd = '',
): {
  data: { reads: string[]; writes: string[]; pathHints: string[] } | null;
  literals: string[];
  imports: string[];
  changesPath: boolean;
} | null {
  const output = inspectPython(source, 'data');
  if (output === null) return null;
  try {
    const value: unknown = JSON.parse(output);
    if (
      !isRecord(value) ||
      typeof value.recognized !== 'boolean' ||
      !Array.isArray(value.reads) ||
      !Array.isArray(value.writes) ||
      !Array.isArray(value.imports) ||
      !value.imports.every(
        (text): text is string => typeof text === 'string',
      ) ||
      typeof value.changesPath !== 'boolean' ||
      !Array.isArray(value.literals) ||
      !value.literals.every((text): text is string => typeof text === 'string')
    )
      return null;
    const metadata = {
      literals: value.literals as string[],
      imports: value.imports as string[],
      changesPath: value.changesPath,
    };
    if (!value.recognized || hasPythonStartupRisk(fetchedFiles))
      return { data: null, ...metadata };
    const paths = [...value.reads, ...value.writes];
    if (!paths.every((file): file is string => typeof file === 'string'))
      return null;
    const pathHints: string[] = [];
    for (const file of paths) {
      const resolved = resolvePath(file, cwd);
      const actual = resolved === null ? null : resolveWorkspacePath(resolved);
      if (
        !actual ||
        !isWithinRoot(actual, WORKSPACE_ROOT) ||
        !isRealWorkspacePath(actual)
      )
        return { data: null, ...metadata };
      pathHints.push(
        file,
        resolved as string,
        path.relative(WORKSPACE_ROOT, actual),
      );
    }
    return {
      data: {
        reads: value.reads as string[],
        writes: value.writes as string[],
        pathHints,
      },
      ...metadata,
    };
  } catch {
    return null;
  }
}

export function pythonImportRisk(
  fetchedFiles: Iterable<string>,
  importRoot: Cwd,
  isolated: boolean,
  inspection: ReturnType<typeof inspectPythonInline>,
): boolean {
  for (const file of fetchedFiles) {
    if (file.includes('\0')) return true;
    if (!PYTHON_IMPORTABLE.test(file)) continue;
    if (isolated && !inspection?.changesPath) continue;
    if (isolated || importRoot === null) return true;
    const root = importRoot || '.';
    const actualRoot =
      resolveWorkspacePath(root) ??
      (path.isAbsolute(root) &&
      isWithinRoot(root, resolveCanonicalPath(WORKSPACE_ROOT))
        ? root
        : null);
    const actualFile = resolveWorkspacePath(file);
    if (!actualRoot || !actualFile) return true;
    const lexical = isWithinRoot(actualFile, actualRoot);
    const canonicalRoot = canonicalFromExistingAncestor(actualRoot);
    const canonicalFile = canonicalFromExistingAncestor(actualFile);
    if (!canonicalRoot || !canonicalFile) return true;
    if (!lexical && !isWithinRoot(canonicalFile, canonicalRoot)) continue;
    const relative = lexical
      ? path.relative(actualRoot, actualFile)
      : path.relative(canonicalRoot, canonicalFile);
    // Direct modules and package initializers may also be imported by trusted
    // dependencies. Nested namespace modules need a matching visible import;
    // script/stdin bodies are not inspected, so their imports stay unknown.
    if (
      !relative.includes(path.sep) ||
      relative.endsWith(`${path.sep}__init__.py`) ||
      !inspection
    )
      return true;
    const module = relative
      .replace(PYTHON_IMPORTABLE, '')
      .split(path.sep)
      .join('.');
    if (
      inspection.imports.some(
        (name) => module === name || module.startsWith(`${name}.`),
      )
    )
      return true;
  }
  return false;
}

export function withoutPythonComments(source: string): string | null {
  const output = inspectPython(source, 'comments');
  if (output === null) return null;
  try {
    const masked: unknown = JSON.parse(output);
    return typeof masked === 'string' ? masked : null;
  } catch {
    return null;
  }
}
