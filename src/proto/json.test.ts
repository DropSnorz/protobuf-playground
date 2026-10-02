import { describe, expect, it } from 'vitest';
import { stringifyJson } from './json';

describe('stringifyJson', () => {
  it('keeps -0 and round-trips through JSON.parse', () => {
    const text = stringifyJson({ zero: 0, minus_zero: -0, list: [-0, 1] }, 2);
    expect(text).toContain('"minus_zero": -0');
    const back = JSON.parse(text);
    expect(Object.is(back.minus_zero, -0)).toBe(true);
    expect(Object.is(back.zero, 0)).toBe(true);
    expect(Object.is(back.list[0], -0)).toBe(true);
  });

  it('matches JSON.stringify otherwise', () => {
    const v = { a: 'x', b: [1, 2.5, true, null], c: { d: '-0' } };
    expect(stringifyJson(v, 2)).toBe(JSON.stringify(v, null, 2));
  });
});
