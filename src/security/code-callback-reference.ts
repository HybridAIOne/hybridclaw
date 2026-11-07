/**
 * Recognize short, nonliteral Python sorting callbacks in private tool history.
 * This is a conservative syntax exception, not a Python parser or redactor;
 * quoted values and unrelated calls stay on the strict credential path.
 */
export function isCodeCallbackReference(
  input: string,
  offset: number,
  value: string,
  maxReferenceLength: number,
): boolean {
  const reference = value.replace(/[)\]},;]+$/, '');
  if (value === 'lambda') {
    const tail = input
      .slice(offset)
      .match(/^key\s*=\s*lambda\s+([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*:/);
    if (!tail) return false;
  } else if (
    reference.length >= maxReferenceLength ||
    !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(reference)
  ) {
    return false;
  }

  let index = offset - 1;
  while (index >= 0 && /\s/.test(input[index])) index -= 1;
  if (input[index] !== '(' && input[index] !== ',') return false;
  let depth = 0;
  let quote = '';
  for (; index >= 0; index -= 1) {
    const character = input[index];
    if (character === "'" || character === '"') {
      let before = index - 1;
      while (before >= 0 && input[before] === '\\') before -= 1;
      if ((index - before) % 2 === 1) {
        if (quote === character) quote = '';
        else if (!quote) quote = character;
      }
      continue;
    }
    if (quote) continue;
    if (character === ')') depth += 1;
    else if (character === '(') {
      if (depth) {
        depth -= 1;
        continue;
      }
      let end = index;
      while (end > 0 && /\s/.test(input[end - 1])) end -= 1;
      let start = end;
      while (start > 0 && /[\w.]/.test(input[start - 1])) start -= 1;
      const callee = input.slice(start, end);
      return (
        ['sorted', 'max', 'min'].includes(callee) ||
        /^(?:[A-Za-z_]\w*\.)+sort$/.test(callee)
      );
    } else if (character === ';' && depth === 0) return false;
  }
  return false;
}
