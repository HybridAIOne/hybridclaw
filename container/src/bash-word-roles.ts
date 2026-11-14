/**
 * Parsed shell argv retains which words actually introduced a redirection.
 * Literal operators stay data through slices and command-prefix removal;
 * unlike path inspection, this records syntax and grants no permission.
 * Facts are parser-local; unannotated argv proves no literal roles.
 */
const redirectsByWords = new WeakMap<readonly string[], ReadonlySet<number>>();

export function recordShellRedirects(
  words: readonly string[],
  redirects: Iterable<number>,
): void {
  redirectsByWords.set(words, new Set(redirects));
}

export function isShellRedirect(
  words: readonly string[],
  index: number,
): boolean | undefined {
  return redirectsByWords.get(words)?.has(index);
}

export function sliceShellWords(
  words: readonly string[],
  start: number,
  end = words.length,
): string[] {
  const result = words.slice(start, end);
  const redirects = redirectsByWords.get(words);
  if (redirects) {
    recordShellRedirects(
      result,
      [...redirects]
        .filter((index) => index >= start && index < end)
        .map((index) => index - start),
    );
  }
  return result;
}

export function concatShellWords(...parts: readonly string[][]): string[] {
  const result = parts.flat();
  if (parts.every((words) => redirectsByWords.has(words))) {
    const redirects: number[] = [];
    let offset = 0;
    for (const words of parts) {
      for (const index of redirectsByWords.get(words) ?? []) {
        redirects.push(offset + index);
      }
      offset += words.length;
    }
    recordShellRedirects(result, redirects);
  }
  return result;
}
