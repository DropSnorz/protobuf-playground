import protobuf from 'protobufjs';
import { describe, expect, it } from 'vitest';
import { decode, toJson } from './decoder';
import { encode } from './encoder';
import { parseSchema } from './schema';
import { toHex } from './wire';

const PROTO = `syntax = "proto3";
package demo;
enum Status { STATUS_UNSPECIFIED = 0; ACTIVE = 1; BANNED = 2; }
message Address { string street = 1; string city = 2; int32 zip = 3; }
message Person {
  int32 id = 1;
  string name = 2;
  optional int32 age = 3;
  repeated int32 scores = 4;
  repeated string tags = 5;
  Address address = 6;
  repeated Address previous = 7;
  map<string, int32> counters = 8;
  map<int32, Address> places = 9;
  Status status = 10;
  sint32 delta = 11;
  sint64 big_delta = 12;
  fixed32 f32 = 13;
  sfixed64 sf64 = 14;
  double ratio = 15;
  float temp = 16;
  bool active = 17;
  bytes blob = 18;
  int64 big = 19;
  uint64 ubig = 20;
  repeated double values = 21 [packed = false];
  oneof contact { string email = 22; string phone = 23; }
  int32 neg = 2000;
}`;

const VALUE = {
  id: 150,
  name: 'Alice ✓',
  age: 0,
  scores: [1, 300, -5],
  tags: ['a', 'bc'],
  address: { street: '1 Main', city: 'Paris', zip: 75001 },
  previous: [{ city: 'Lyon' }, {}],
  counters: { x: 1, y: 0 },
  places: { '7': { city: 'Nice' } },
  status: 'BANNED',
  delta: -3,
  big_delta: '-9000000000',
  f32: 4000000000,
  sf64: '-2',
  ratio: 0.1,
  temp: -1.5,
  active: true,
  blob: 'AQID',
  big: '9007199254740993',
  ubig: '18446744073709551615',
  values: [1.5, 2],
  phone: '555',
  neg: -1,
};

function reference() {
  const root = protobuf.parse(PROTO, { keepCase: true }).root;
  const T = root.lookupType('demo.Person');
  const msg = T.fromObject(VALUE);
  return T.encode(msg).finish();
}

describe('codec', () => {
  const parsed = parseSchema(PROTO);
  if (!parsed.ok) throw new Error(parsed.error.message);
  const schema = parsed.schema;

  it('encodes the classic 150 example', () => {
    const r = encode(schema, '.demo.Person', { id: 150 });
    expect(toHex(r.bytes)).toBe('08 96 01');
  });

  it('is readable by protobufjs and matches its own encoding', () => {
    const r = encode(schema, '.demo.Person', VALUE);
    expect(r.errors).toEqual([]);
    const ref = reference();
    // protobufjs does not pack proto3 repeated scalars by default (the spec does),
    // so compare what both byte strings decode to rather than the raw bytes.
    // decode both with protobufjs and compare objects
    const root = protobuf.parse(PROTO, { keepCase: true }).root;
    const T = root.lookupType('demo.Person');
    const opts = { longs: String, enums: String, bytes: String, defaults: false };
    expect(T.toObject(T.decode(r.bytes), opts)).toEqual(T.toObject(T.decode(ref), opts));
  });

  it('round-trips through the annotated decoder', () => {
    const r = encode(schema, '.demo.Person', VALUE);
    const d = decode(schema, '.demo.Person', r.bytes);
    expect(d.ok).toBe(true);
    const json = toJson(d.message!, false, schema) as Record<string, unknown>;
    expect(json.id).toBe(150);
    expect(json.name).toBe('Alice ✓');
    expect(json.age).toBe(0);
    expect(json.scores).toEqual([1, 300, -5]);
    expect(json.status).toBe('BANNED');
    expect(json.delta).toBe(-3);
    expect(json.big_delta).toBe('-9000000000');
    expect(json.ubig).toBe('18446744073709551615');
    expect(json.big).toBe('9007199254740993');
    expect(json.counters).toEqual({ x: 1, y: 0 });
    expect(json.places).toEqual({ '7': { city: 'Nice' } });
    expect(json.phone).toBe('555');
    expect(json.neg).toBe(-1);
    expect(json.previous).toEqual([{ city: 'Lyon' }, {}]);
    expect(json.values).toEqual([1.5, 2]);
    expect(json.blob).toBe('AQID');
  });

  it('keeps unknown fields and reports defaults', () => {
    const p2 = parseSchema(`syntax = "proto3"; package demo; message Person { string name = 2; int32 score = 30; }`);
    if (!p2.ok) throw new Error();
    const r = encode(schema, '.demo.Person', { id: 7, name: 'Bob' });
    const d = decode(p2.schema, '.demo.Person', r.bytes);
    expect(d.ok).toBe(true);
    expect(d.message!.unknown.map((n) => n.fieldNumber)).toEqual([1]);
    expect(d.message!.fields.find((f) => f.def.name === 'score')!.state).toBe('default');
  });

  it('fails on truncated input and on invalid utf-8', () => {
    const r = encode(schema, '.demo.Person', { name: 'hello' });
    const d = decode(schema, '.demo.Person', r.bytes.slice(0, 4));
    expect(d.ok).toBe(false);
    const d2 = decode(schema, '.demo.Person', Uint8Array.from([0x12, 0x02, 0xff, 0xfe]));
    expect(d2.ok).toBe(false);
    expect(d2.error!.message).toMatch(/UTF-8/);
  });

  it('last one wins for duplicated scalars and merges messages', () => {
    const d = decode(schema, '.demo.Person', Uint8Array.from([0x08, 0x01, 0x08, 0x02, 0x32, 0x03, 0x0a, 0x01, 0x61, 0x32, 0x03, 0x12, 0x01, 0x62]));
    expect(d.ok).toBe(true);
    const json = toJson(d.message!, false, schema) as Record<string, unknown>;
    expect(json.id).toBe(2);
    expect(json.address).toEqual({ street: 'a', city: 'b' });
  });

  it('truncates int64 read as int32', () => {
    const p2 = parseSchema(`syntax = "proto3"; message M { int64 v = 1; }`);
    const p3 = parseSchema(`syntax = "proto3"; message M { int32 v = 1; }`);
    if (!p2.ok || !p3.ok) throw new Error();
    const r = encode(p2.schema, '.M', { v: '4294967297' });
    const d = decode(p3.schema, '.M', r.bytes);
    expect((toJson(d.message!, false, p3.schema) as { v: number }).v).toBe(1);
  });
});
