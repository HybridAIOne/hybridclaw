import { describe, expect, it } from 'vitest';
import {
  array,
  boolean,
  literal,
  nullable,
  number,
  object,
  optional,
  type Schema,
  string,
  unchecked,
  union,
} from '@hybridclaw/contracts/schema';

describe('contract schema checks', () => {
  it.each<[string, Schema<unknown>, unknown[], unknown[]]>([
    ['string', string(), ['', 'a'], [1, null, undefined]],
    ['number', number(), [0, -1.5], [Number.NaN, Infinity, '1', null]],
    ['boolean', boolean(), [true, false], [0, 'true']],
    ['literal', literal('a', 'b'), ['a', 'b'], ['c', null]],
    ['nullable', nullable(string()), ['x', null], [undefined, 1]],
    ['array', array(number()), [[], [1, 2]], [[1, 'x'], {}, null]],
    ['union', union(string(), number()), ['a', 1], [true, null]],
    ['unchecked', unchecked<string>(), [1, null, undefined], []],
  ])('%s accepts and rejects', (_name, schema, accepted, rejected) => {
    for (const value of accepted) expect(schema.check(value)).toBe(true);
    for (const value of rejected) expect(schema.check(value)).toBe(false);
  });

  const Message = object({
    id: string(),
    note: optional(string()),
    tags: optional(array(string())),
  });

  it.each([
    [{ id: 'a' }, true],
    [{ id: 'a', note: 'n', tags: ['x'] }, true],
    [{ id: 'a', note: undefined }, true],
    [{ id: 'a', unknownField: 1 }, true],
    [{ note: 'n' }, false],
    [{ id: undefined }, false],
    [{ id: 'a', note: 1 }, false],
    [[], false],
    [null, false],
  ])('object %j -> %s', (value, expected) => {
    expect(Message.check(value)).toBe(expected);
  });
});
