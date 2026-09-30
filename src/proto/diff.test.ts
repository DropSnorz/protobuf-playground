import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios';
import { diffSchemas } from './diff';
import { parseSchema } from './schema';

const worst = (id: string) => {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const p = parseSchema(s.producer.proto);
  const c = parseSchema(s.consumer!.proto);
  if (!p.ok || !c.ok) throw new Error();
  const d = diffSchemas(p.schema, s.producer.type, c.schema, s.consumer!.type);
  return d.some((e) => e.severity === 'breaking') ? 'breaking' : d.some((e) => e.severity === 'caution') ? 'caution' : 'compatible';
};

describe('schema diff', () => {
  it('rates scenarios consistently with their verdict', () => {
    for (const s of SCENARIOS.filter((x) => x.consumer && x.id !== 'wrong-type')) {
      const expected = s.verdict === 'learn' ? 'compatible' : s.verdict;
      // Statically these are only "caution": the outcome depends on the data sent.
      if (s.id === 'new-field-old-producer' || s.id === 'bytes-to-string') continue;
      expect([s.id, worst(s.id)]).toEqual([s.id, expected]);
    }
  });
});
