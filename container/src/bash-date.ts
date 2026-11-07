/**
 * Date display is read-only only with literal display arguments.
 * Unlike clock-setting forms, these calls can run during file-write recovery;
 * shell substitutions and redirects remain subject to the whole-script policy.
 */
export function isReadOnlyDateCommand(words: string[]): boolean {
  return (
    words[0] === 'date' &&
    words
      .slice(1)
      .every(
        (argument, index, args) =>
          ['-u', '--utc', '--universal'].includes(argument) ||
          (index === args.length - 1 && /^\+[^$`*?[\]{}]*$/.test(argument)),
      )
  );
}
