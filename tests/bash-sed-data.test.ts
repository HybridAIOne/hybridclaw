import { expect, test } from 'vitest';
import { scriptCommands } from '../container/src/bash-commands.js';
import { sedLiteralDataArgs } from '../container/src/bash-sed-data.js';

test.each([
  "sed 's/<[^>]*>//' file.html",
  "gsed -n 's/<[^>]*>//gp' file.html",
  "sed -E -e 's#<[^>]*>##g' -e 's@a@b@2p' file.html",
  "sed --expression='s/a/b/' file.html",
  "sed --expression 's/a/b/' -- file.html",
  "sed -ne 's/a/b/p' file.html",
  "sed -es/a/b/ file.html",
  "sed 's/a\\/b/c/' file.html > out.html",
])('certifies literal substitutions and their exact script operands: %s', (source) => {
  const [{ program, args }] = scriptCommands(source);
  const indexes = sedLiteralDataArgs(program, args);
  expect(indexes?.length).toBeGreaterThan(0);
  expect(indexes?.every((index) => args[index].includes('s'))).toBe(true);
});

test.each([
  "sed 's/a/b/e' file.html",
  "sed 's/a/b/w out.txt' file.html",
  "sed -e 's/a/b/' -e 'w out.txt' file.html",
  "sed 's/a/b/;w out.txt' file.html",
  "sed 's/a/b/\nw out.txt' file.html",
  "sed -f script.sed file.html",
  "sed -i 's/a/b/' file.html",
  "sed -Ei.bak 's/a/b/' file.html",
  "sed --in-place 's/a/b/' file.html",
  "sed --follow-symlinks 's/a/b/' file.html",
  "sed 'r /etc/shadow' file.html",
  "sed 's/a/b' file.html",
  "sed -e",
  'sed',
  "awk 's/a/b/' file.html",
])('keeps unsupported options or nonliteral/mutating scripts opaque: %s', (source) => {
  const [{ program, args }] = scriptCommands(source);
  expect(sedLiteralDataArgs(program, args)).toBeNull();
});
