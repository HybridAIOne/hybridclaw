/**
 * The HTTP method a bash line's curl or wget calls send, for network policy.
 *
 * Flags are read per program from the parsed commands, never from the raw
 * line, so `| tr -d` or wget's `-T` timeout is not a body or an upload. NOT
 * the network policy itself: `approval-policy.ts` matches the method to rules.
 */
import { commandProgram } from './bash-commands.js';

const HTTP_METHOD_FLAGS: Record<
  string,
  { explicit: RegExp; put?: RegExp; post: RegExp }
> = {
  curl: {
    explicit: /(?:^|\s)(?:-X\s*|--request[\s=]+)([A-Za-z]+)/,
    put: /(?:^|\s)(?:-T\S*|--upload-file(?:\s|=|$))/,
    post: /(?:^|\s)(?:-[dF]\S*|(?:--data[\w-]*|--form[\w-]*|--json)(?:\s|=|$))/,
  },
  wget: {
    explicit: /(?:^|\s)--method[\s=]+([A-Za-z]+)/,
    post: /(?:^|\s)(?:--post-data|--post-file|--body-data|--body-file)(?:\s|=|$)/,
  },
};

export function inferBashHttpMethod(commands: string[][]): string {
  for (const words of commands) {
    const { program, args } = commandProgram(words);
    const flags = HTTP_METHOD_FLAGS[program];
    if (!flags) continue;
    const text = args.join(' ');
    const method =
      flags.explicit.exec(text)?.[1]?.toUpperCase() ??
      (flags.put?.test(text) ? 'PUT' : flags.post.test(text) ? 'POST' : 'GET');
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
