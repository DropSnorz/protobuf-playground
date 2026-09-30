import { describe, expect, it } from 'vitest';
import { decode, toJson } from '../proto/decoder';
import { diffSchemas } from '../proto/diff';
import { encode } from '../proto/encoder';
import { matchTypeName, parseSchema } from '../proto/schema';
import { buildSteps } from '../proto/steps';
import { parseHex } from '../proto/wire';
import { SCENARIOS } from './index';

function run(id: string) {
  const s = SCENARIOS.find((x) => x.id === id)!;
  const p = parseSchema(s.producer.proto);
  const c = parseSchema((s.consumer ?? s.producer).proto);
  if (!p.ok) throw new Error(`${s.id} producer: ${p.error.message}`);
  if (!c.ok) throw new Error(`${s.id} consumer: ${c.error.message}`);
  const enc = encode(p.schema, s.producer.type, s.value);
  const bytes = s.wireHex ? (parseHex(s.wireHex) as Uint8Array) : enc.bytes;
  const ctype = matchTypeName(c.schema, (s.consumer ?? s.producer).type)!;
  const dec = decode(c.schema, ctype, bytes);
  return { s, p, c, enc, bytes, dec, json: dec.message ? (toJson(dec.message, false, c.schema) as Record<string, unknown>) : null, ctype };
}

describe('scenarios', () => {
  it('have unique ids', () => {
    expect(new Set(SCENARIOS.map((s) => s.id)).size).toBe(SCENARIOS.length);
  });
  for (const s of SCENARIOS) {
    it(`${s.id} runs as expected`, () => {
      const r = run(s.id);
      expect(r.enc.errors).toEqual([]);
      expect(r.p.ok && r.p.warnings).toEqual([]);
      if (s.wireHex) expect(typeof parseHex(s.wireHex)).not.toBe('string');
      expect(r.dec.ok).toBe((s.expect ?? 'ok') === 'ok');
      const steps = buildSteps({ enc: r.enc, dec: r.dec, bytes: r.bytes, override: !!s.wireHex, producerType: s.producer.type, consumerType: r.ctype });
      expect(steps.length).toBeGreaterThan(2);
      if (r.p.ok && r.c.ok) diffSchemas(r.p.schema, s.producer.type, r.c.schema, r.ctype);
    });
  }

  it('specific outcomes', () => {
    expect(run('int64-to-int32').json).toEqual({ views: 1, bytes_sent: -1294967296, likes: 42 });
    expect(run('zigzag-mismatch').json).toEqual({ a: -1, b: 1, c: -2147483648 });
    expect(run('float-fixed32').json).toEqual({ value: 1069547520 });
    expect(run('concat-merge').json).toEqual({ name: 'Ann', tags: ['a', 'b'], address: { city: 'Paris', zip: 75 } });
    expect(run('into-oneof').json).toEqual({ phone: '+1 555 0100' });
    expect(run('oneof-two-members').json).toEqual({ phone: '555' });
    expect(run('map-duplicate-key').json).toEqual({ counts: { a: 2, '': 0 } });
    expect(run('repeated-to-singular').json).toEqual({ email: 'c@x.io' });
    expect(run('new-enum-value').json).toEqual({ id: 'o-1', status: 4, history: ['PENDING', 'PAID', 4] });
    expect(run('map-as-repeated').json).toEqual({ name: 'web-1', labels: [{ key: 'app', value: 'web' }, { key: 'tier', value: 'front' }] });
    expect(run('int-to-bool').json).toEqual({ retries: true });
    expect(run('uint-int-sign').json).toEqual({ mask: -1, small: 10 });
    expect(run('field-order').json).toEqual({ id: 7, name: 'hi' });
    expect(run('non-canonical-varint').json).toEqual({ id: 1 });
    expect(run('empty-message').bytes.length).toBe(0);
    expect(run('reused-number').dec.message!.unknown.length).toBe(1);
    expect(run('repeated-num-to-singular').dec.message!.unknown.length).toBe(1);
  });
});
