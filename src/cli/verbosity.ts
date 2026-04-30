/**
 * Shared verbosity convention for hybridclaw subcommands.
 *
 * Three levels, named so that defaults sit in the middle and each end is
 * a single explicit flag:
 *
 *   --quiet  / -q  → minimal output (totals/summary only)
 *   (default)      → standard       (matched/relevant items + summary)
 *   --all          → extended       (every item, including clean/skipped)
 *
 * `-v`/`--verbose` is intentionally NOT used here — `-v` is reserved at
 * the top level (`hybridclaw -v` prints the version). `--all` reads more
 * naturally for "show me everything" anyway.
 *
 * Usage in a subcommand:
 *
 *   const verbosity = parseOutputVerbosity(args);
 *   const remaining = stripVerbosityFlags(args);
 *
 * Pass `verbosity` to your renderer; use `remaining` for further parsing.
 */

export type OutputVerbosity = 'quiet' | 'standard' | 'all';

const QUIET_FLAGS = new Set(['--quiet', '-q']);
const ALL_FLAGS = new Set(['--all']);

export function parseOutputVerbosity(
  args: ReadonlyArray<string>,
): OutputVerbosity {
  let level: OutputVerbosity = 'standard';
  for (const arg of args) {
    if (QUIET_FLAGS.has(arg)) level = 'quiet';
    else if (ALL_FLAGS.has(arg)) level = 'all';
  }
  return level;
}

export function stripVerbosityFlags(args: ReadonlyArray<string>): string[] {
  return args.filter((arg) => !QUIET_FLAGS.has(arg) && !ALL_FLAGS.has(arg));
}

/**
 * Standard one-line help fragment subcommands can splice into their
 * usage text so the convention is uniform across the CLI.
 */
export const VERBOSITY_HELP_LINE =
  '--quiet | --all                    Verbosity: quiet = summary only, default = relevant items + summary, all = include clean/skipped items';
