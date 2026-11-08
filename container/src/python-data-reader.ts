/**
 * Recognizes a bounded subset of Python that only reads and transforms data.
 * The isolated parser never executes the supplied source. A failed or unknown
 * parse is not permission; bash-remote-code retains its conservative result.
 * This is not a general Python sandbox or an approval-policy replacement.
 */
import { spawnSync } from 'node:child_process';

// Codex, 2026-11-08: cap untrusted parsing at 32 KiB / 4096 nodes
// and one second. Missing system Python keeps the existing approval path.
const MAX_SOURCE_BYTES = 32 * 1024;
const PARSER_TIMEOUT_MS = 1000;

const READ_ONLY_PYTHON = `
import ast, sys

class Unknown(Exception):
    pass

DATA = 'data'
FILE = 'file'
PURE = {'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'tuple', 'set',
        'sorted', 'enumerate', 'range', 'min', 'max', 'sum', 'abs', 'round'}
METHODS = {'get', 'items', 'keys', 'values', 'strip', 'split', 'splitlines',
           'join', 'lower', 'upper', 'replace'}

class Reader:
    def __init__(self):
        self.names = {}
        self.reserved = PURE | {'open', 'print'}

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
            if self.names.get(node.id) in {DATA, FILE}:
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
            if isinstance(fn.value, ast.Name) and self.names.get(fn.value.id) == 'json':
                if len(node.args) != 1 or node.keywords:
                    raise Unknown()
                if fn.attr == 'load' and self.expr(node.args[0]) == FILE:
                    return DATA
                if fn.attr in {'loads', 'dumps'}:
                    self.data(node.args[0])
                    return DATA
            kind = self.expr(fn.value)
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
                    if self.expr(item.context_expr) != FILE or item.optional_vars is None:
                        raise Unknown()
                    self.bind(item.optional_vars, FILE)
                self.statements(node.body)
            elif not isinstance(node, (ast.Pass, ast.Break, ast.Continue)):
                raise Unknown()

try:
    tree = ast.parse(sys.stdin.read())
    if sum(1 for _ in ast.walk(tree)) > 4096:
        raise Unknown()
    Reader().statements(tree.body)
    print('data')
except Exception:
    print('unknown')
`;

export function isReadOnlyPythonInline(
  source: string,
  fetchedFiles: Iterable<string>,
): boolean {
  if (Buffer.byteLength(source) > MAX_SOURCE_BYTES) return false;
  // Downloaded importable code may shadow the standard modules this subset
  // uses. Unknown locations cannot establish a data-only interpretation either.
  for (const file of fetchedFiles) {
    if (file.includes('\0') || /\.(?:py[co]?|so|pyd|zip|egg)$/i.test(file))
      return false;
  }
  const result = spawnSync(
    '/usr/bin/python3',
    ['-I', '-S', '-B', '-c', READ_ONLY_PYTHON],
    {
      input: source,
      encoding: 'utf8',
      timeout: PARSER_TIMEOUT_MS,
      maxBuffer: 1024,
      windowsHide: true,
    },
  );
  return (
    result.status === 0 &&
    !result.error &&
    typeof result.stdout === 'string' &&
    result.stdout.trim() === 'data'
  );
}
