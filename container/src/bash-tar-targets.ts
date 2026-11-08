/**
 * Tar output roles distinguish archive inputs from extraction destinations.
 * Unlike the workspace fence, this only interprets recognized CLI arguments;
 * it does not inspect archive members, links, environment options or hooks.
 */
export const TAR_PROGRAMS = new Set(['tar', 'bsdtar', 'gtar']);

// Codex, 2026-11-08: recognize common GNU/BSD argument roles; file-list
// effects, hooks and ambiguous modes deliberately retain the existing fallback.
const FLAGS: Readonly<
  Record<string, 'extract' | 'archive' | 'stdout' | 'read' | 'flag'>
> = {
  x: 'extract',
  '--extract': 'extract',
  '--get': 'extract',
  c: 'archive',
  '--create': 'archive',
  r: 'archive',
  '--append': 'archive',
  u: 'archive',
  '--update': 'archive',
  A: 'archive',
  '--concatenate': 'archive',
  '--catenate': 'archive',
  '--delete': 'archive',
  O: 'stdout',
  '--to-stdout': 'stdout',
  t: 'read',
  '--list': 'read',
  d: 'read',
  '--diff': 'read',
  '--compare': 'read',
  v: 'flag',
  '--verbose': 'flag',
  z: 'flag',
  '--gzip': 'flag',
  '--gunzip': 'flag',
  j: 'flag',
  '--bzip2': 'flag',
  J: 'flag',
  '--xz': 'flag',
  a: 'flag',
  '--auto-compress': 'flag',
  p: 'flag',
  '--same-permissions': 'flag',
  '--preserve-permissions': 'flag',
  o: 'flag',
  '--no-same-owner': 'flag',
  m: 'flag',
  '--touch': 'flag',
  k: 'flag',
  '--keep-old-files': 'flag',
  h: 'flag',
  '--dereference': 'flag',
  '--no-recursion': 'flag',
};

const VALUES: Readonly<
  Record<string, 'file' | 'directory' | 'input' | 'opaque'>
> = {
  f: 'file',
  '--file': 'file',
  C: 'directory',
  '--directory': 'directory',
  b: 'input',
  '--blocking-factor': 'input',
  '--format': 'input',
  X: 'input',
  '--exclude-from': 'input',
  '--exclude': 'input',
  '--strip-components': 'input',
  '--owner': 'input',
  '--group': 'input',
  '--mode': 'input',
  '--mtime': 'input',
  N: 'input',
  '--newer': 'input',
  '--newer-mtime': 'input',
  V: 'input',
  '--label': 'input',
  // Lists can contain -C; filters, scripts and snapshots have other effects.
  T: 'opaque',
  '--files-from': 'opaque',
  I: 'opaque',
  '--use-compress-program': 'opaque',
  F: 'opaque',
  '--info-script': 'opaque',
  '--new-volume-script': 'opaque',
  g: 'opaque',
  '--listed-incremental': 'opaque',
  '--transform': 'opaque',
  '--xform': 'opaque',
  '--to-command': 'opaque',
};
// H/s take values in only one of GNU/BSD tar. Leave them unresolved rather
// than consuming a following operation flag in the other implementation.

export function tarWriteTargets(args: string[]): {
  targets: string[];
  parsed: boolean;
} {
  let extract = false;
  let archive = false;
  let stdout = false;
  let operation = false;
  let parsed = true;
  let directory = '.';
  const members: string[] = [];
  const files: string[] = [];

  const flag = (name: string) => {
    switch (FLAGS[name]) {
      case 'extract':
        extract = true;
        operation = true;
        break;
      case 'archive':
        archive = true;
        operation = true;
        break;
      case 'stdout':
        stdout = true;
        break;
      case 'read':
        operation = true;
        break;
      case 'flag':
        break;
      default:
        parsed = false;
    }
  };
  const value = (name: string, arg: string | undefined) => {
    if (arg === undefined) {
      parsed = false;
      return;
    }
    switch (VALUES[name]) {
      case 'file':
        files.push(arg);
        break;
      case 'directory':
        directory =
          /^[~/]/.test(arg) || directory === '.' ? arg : `${directory}/${arg}`;
        break;
      case 'opaque':
        parsed = false;
        break;
      case 'input':
        break;
    }
  };

  let options = true;
  for (let index = 0; index < args.length; ) {
    const first = index === 0;
    const arg = args[index++];
    if (options && arg === '--') {
      options = false;
      continue;
    }
    if (!options || arg === '-' || (!first && !arg.startsWith('-'))) {
      members.push(directory);
    } else if (arg.startsWith('--')) {
      const equals = arg.indexOf('=');
      const name = equals < 0 ? arg : arg.slice(0, equals);
      if (VALUES[name])
        value(name, equals < 0 ? args[index++] : arg.slice(equals + 1));
      else {
        flag(name);
        if (equals >= 0) parsed = false;
      }
    } else {
      const oldStyle = !arg.startsWith('-');
      const letters = oldStyle ? arg : arg.slice(1);
      for (let position = 0; position < letters.length; position++) {
        const name = letters[position];
        if (!VALUES[name]) {
          flag(name);
          continue;
        }
        value(
          name,
          oldStyle
            ? args[index++]
            : letters.slice(position + 1) || args[index++],
        );
        if (!oldStyle) break;
      }
    }
  }
  return {
    targets: [
      ...(archive ? files.filter((file) => file !== '-') : []),
      ...(extract && !stdout ? (members.length ? members : [directory]) : []),
    ],
    // The default archive can be a device or environment-selected path.
    parsed: parsed && operation && (!archive || files.length > 0),
  };
}
