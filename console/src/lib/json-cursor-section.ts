type JsonSection = {
  name: string;
  start: number;
};

function readJsonStringEnd(value: string, start: number): number {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') return index;
  }
  return value.length - 1;
}

function readTopLevelSections(value: string): JsonSection[] {
  const sections: JsonSection[] = [];
  let depth = 0;
  let expectingTopLevelKey = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '"') {
      const end = readJsonStringEnd(value, index);
      if (depth === 1 && expectingTopLevelKey) {
        let colon = end + 1;
        while (/\s/u.test(value[colon] ?? '')) colon += 1;
        if (value[colon] === ':') {
          try {
            const name = JSON.parse(value.slice(index, end + 1)) as string;
            sections.push({ name, start: index });
            expectingTopLevelKey = false;
          } catch {
            // Keep scanning malformed draft JSON; the editor owns parse errors.
          }
        }
      }
      index = end;
      continue;
    }
    if (char === '{' || char === '[') {
      depth += 1;
      if (depth === 1 && char === '{') expectingTopLevelKey = true;
      continue;
    }
    if (char === '}' || char === ']') {
      if (depth === 1) expectingTopLevelKey = false;
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (char === ',' && depth === 1) expectingTopLevelKey = true;
  }

  return sections;
}

export function findTopLevelJsonSection(
  value: string,
  cursorOffset: number,
): string | null {
  const offset = Math.max(0, Math.min(cursorOffset, value.length));
  const sections = readTopLevelSections(value);
  let current: JsonSection | null = null;
  for (const section of sections) {
    if (section.start > offset) break;
    current = section;
  }
  return current?.name ?? null;
}
