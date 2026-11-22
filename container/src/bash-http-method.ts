/**
 * The HTTP method a bash line's curl, wget or httpie calls send, for network
 * policy.
 *
 * Flags are read per program from the parsed commands, never from the raw
 * line, so `| tr -d` or wget's `-T` timeout is not a body or an upload. NOT
 * the network policy itself: `approval-policy.ts` matches the method to rules.
 */
import { commandProgram } from './bash-commands.js';

// curl's short options that take a value (curl 8 manual). The value ends a
// cluster, as the rest of the word or the next word: `-sXPOST`, `-fsSLd x`.
const CURL_VALUE_LETTERS = new Set('AbcCdDeEFHKmoPQrtTuUwxXyYz');

function curlMethod(args: string[]): string {
  let explicit = '';
  let body = '';
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let option = '';
    let value: string | undefined;
    const long = /^--([\w-]+)(?:=(.*))?$/.exec(arg);
    if (long) {
      [, option, value] = long;
    } else if (/^-[^-]/.test(arg)) {
      const at = [...arg.slice(1)].findIndex((letter) =>
        CURL_VALUE_LETTERS.has(letter),
      );
      if (at < 0) continue;
      option = arg[at + 1];
      value = arg.slice(at + 2) || args[++index];
    }
    if (option === 'X' || option === 'request') {
      explicit = (value ?? args[++index] ?? '').toUpperCase();
    } else if (option === 'T' || option === 'upload-file') {
      body = 'PUT';
    } else if (/^(?:[dF]|data[\w-]*|form[\w-]*|json)$/.test(option)) {
      body ||= 'POST';
    }
  }
  return explicit || body || 'GET';
}

function wgetMethod(args: string[]): string {
  const text = args.join(' ');
  return (
    /(?:^|\s)--method[\s=]+([A-Za-z]+)/.exec(text)?.[1]?.toUpperCase() ??
    (/(?:^|\s)--(?:post|body)-(?:data|file)(?:\s|=|$)/.test(text)
      ? 'POST'
      : 'GET')
  );
}

// httpie: `http [METHOD] URL [ITEM...]`. Without a method it sends GET, or
// POST when an item carries data (`a=b`, `a:=1`, `a@file`) or `--raw` sets the
// body; `a==b` is a query parameter and `A:b` a header.
function httpieMethod(args: string[]): string {
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const urlAt = positional.findIndex((arg) => /^[a-z]+:\/\//i.test(arg));
  const method = positional[urlAt - 1];
  if (urlAt > 0 && /^[A-Za-z]+$/.test(method)) return method.toUpperCase();
  const sends =
    args.some((arg) => /^--raw(?:=|$)/.test(arg)) ||
    positional
      .slice(urlAt + 1)
      .some(
        (item) => /^[^:=@]+(?::=|=|@)/.test(item) && !/^[^:=@]+==/.test(item),
      );
  return sends ? 'POST' : 'GET';
}

const HTTP_METHOD_BY_PROGRAM = new Map<string, (args: string[]) => string>([
  ['curl', curlMethod],
  ['wget', wgetMethod],
  ['http', httpieMethod],
  ['https', httpieMethod],
]);

export function isHttpClientCommand(words: string[]): boolean {
  return HTTP_METHOD_BY_PROGRAM.has(commandProgram(words).program);
}

export function inferBashHttpMethod(commands: string[][]): string {
  for (const words of commands) {
    const { program, args } = commandProgram(words);
    const method = HTTP_METHOD_BY_PROGRAM.get(program)?.(args) ?? 'GET';
    if (!isReadOnlyHttpMethod(method)) return method;
  }
  return 'GET';
}

export function normalizeHttpMethod(value: unknown): string {
  const normalized = String(value || 'GET')
    .trim()
    .toUpperCase();
  return normalized || 'GET';
}

export function isReadOnlyHttpMethod(method: string): boolean {
  return ['GET', 'HEAD', 'OPTIONS'].includes(normalizeHttpMethod(method));
}
