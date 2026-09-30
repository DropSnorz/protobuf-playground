/**
 * Proto3 encoder that records, for every byte it writes, which field it
 * belongs to and how it was computed. Written from scratch (instead of using
 * protobufjs' encoder) so the playground can explain every step.
 */
import { shortName } from './schema';
import { nextId, shiftNode, type Calc, type TraceNode } from './trace';
import { WireType, type FieldDef, type MessageDef, type Schema, type ScalarType } from './types';
import {
  base64Decode,
  encodeFixed,
  encodeVarint,
  formatFloat,
  makeTag,
  toHex,
  utf8Encode,
  wireTypeFor,
  zigzagEncode,
} from './wire';

export interface EncodeIssue {
  path: string;
  message: string;
}

export interface EncodeResult {
  bytes: Uint8Array;
  nodes: TraceNode[];
  errors: EncodeIssue[];
  typeName: string;
}

type Scalar = bigint | number | boolean | string | Uint8Array;

const INT_RANGES: Record<string, [bigint, bigint]> = {
  int32: [-(2n ** 31n), 2n ** 31n - 1n],
  sint32: [-(2n ** 31n), 2n ** 31n - 1n],
  sfixed32: [-(2n ** 31n), 2n ** 31n - 1n],
  uint32: [0n, 2n ** 32n - 1n],
  fixed32: [0n, 2n ** 32n - 1n],
  int64: [-(2n ** 63n), 2n ** 63n - 1n],
  sint64: [-(2n ** 63n), 2n ** 63n - 1n],
  sfixed64: [-(2n ** 63n), 2n ** 63n - 1n],
  uint64: [0n, 2n ** 64n - 1n],
  fixed64: [0n, 2n ** 64n - 1n],
};

class Ctx {
  errors: EncodeIssue[] = [];
  constructor(public schema: Schema) {}
  err(path: string, message: string) {
    this.errors.push({ path, message });
  }
  enumName(type: string) {
    return shortName(type, this.schema.packageName);
  }
}

class ConvertError extends Error {}

/** JSON value -> typed scalar (throws ConvertError). */
function convertScalar(ctx: Ctx, field: { type: string; kind: FieldDef['kind'] }, v: unknown): Scalar {
  if (field.kind === 'enum') {
    const e = ctx.schema.enums.get(field.type)!;
    if (typeof v === 'string') {
      if (!(v in e.values)) {
        throw new ConvertError(`"${v}" is not a value of enum ${e.name} (${Object.keys(e.values).join(', ')})`);
      }
      return BigInt(e.values[v]);
    }
    if (typeof v === 'number' && Number.isInteger(v)) {
      if (v < -(2 ** 31) || v > 2 ** 31 - 1) throw new ConvertError('enum numbers are int32');
      return BigInt(v);
    }
    throw new ConvertError(`expected an enum name (string) or number for ${e.name}`);
  }
  const t = field.type as ScalarType;
  switch (t) {
    case 'string':
      if (typeof v !== 'string') throw new ConvertError('expected a string');
      return v;
    case 'bytes': {
      if (Array.isArray(v)) {
        if (!v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
          throw new ConvertError('byte arrays must contain integers 0..255');
        }
        return Uint8Array.from(v as number[]);
      }
      if (typeof v !== 'string') throw new ConvertError('expected base64 string (or array of byte values)');
      const b = base64Decode(v);
      if (!b) throw new ConvertError('invalid base64');
      return b;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'false') return v === 'true';
      throw new ConvertError('expected true or false');
    case 'float':
    case 'double': {
      if (typeof v === 'number') return v;
      if (v === 'NaN') return NaN;
      if (v === 'Infinity') return Infinity;
      if (v === '-Infinity') return -Infinity;
      if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) return Number(v);
      throw new ConvertError('expected a number (or "NaN", "Infinity", "-Infinity")');
    }
    default: {
      let big: bigint;
      if (typeof v === 'number') {
        if (!Number.isInteger(v)) throw new ConvertError(`expected an integer for ${t}`);
        if (!Number.isSafeInteger(v)) {
          throw new ConvertError(`${v} exceeds JS safe integer range — pass 64-bit values as strings, e.g. "9007199254740993"`);
        }
        big = BigInt(v);
      } else if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) {
        big = BigInt(v.trim());
      } else {
        throw new ConvertError(`expected an integer for ${t}`);
      }
      const range = INT_RANGES[t];
      if (range && (big < range[0] || big > range[1])) {
        throw new ConvertError(`${big} is out of range for ${t} [${range[0]}, ${range[1]}]`);
      }
      return big;
    }
  }
}

function isDefault(v: Scalar): boolean {
  if (typeof v === 'bigint') return v === 0n;
  if (typeof v === 'number') return Object.is(v, 0); // -0 is NOT default: its bits are non-zero
  if (typeof v === 'boolean') return v === false;
  if (typeof v === 'string') return v.length === 0;
  return v.length === 0;
}

export function displayScalar(
  ctx: { schema: Schema },
  type: string,
  kind: FieldDef['kind'],
  v: Scalar,
): string {
  if (kind === 'enum') {
    const e = ctx.schema.enums.get(type);
    const name = e?.byNumber.get(Number(v));
    return name ? `${name} (${v})` : `${v}`;
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Uint8Array) return v.length ? `0x${toHex(v, '')}` : '(empty)';
  if (typeof v === 'number') return formatFloat(v);
  return String(v);
}

/** Encode a scalar payload, returning bytes + worksheet. */
function encodeScalarPayload(ctx: Ctx, type: string, kind: FieldDef['kind'], v: Scalar): { bytes: number[]; calc: Calc[] } {
  const calc: Calc[] = [];
  if (kind === 'enum') {
    const e = ctx.schema.enums.get(type)!;
    const n = v as bigint;
    calc.push({ kind: 'enum', enumName: e.name, name: e.byNumber.get(Number(n)) ?? null, number: Number(n) });
    if (n < 0n) calc.push({ kind: 'twos', input: n, output: BigInt.asUintN(64, n) });
    const bytes = encodeVarint(n);
    calc.push({ kind: 'varint', value: BigInt.asUintN(64, n), bytes });
    return { bytes, calc };
  }
  switch (type as ScalarType) {
    case 'string': {
      const bytes = utf8Encode(v as string);
      calc.push({ kind: 'utf8', text: v as string, bytes });
      return { bytes, calc };
    }
    case 'bytes': {
      const bytes = Array.from(v as Uint8Array);
      calc.push({ kind: 'bytes', bytes });
      return { bytes, calc };
    }
    case 'bool': {
      const bytes = [v ? 1 : 0];
      calc.push({ kind: 'bool', value: v as boolean });
      calc.push({ kind: 'varint', value: v ? 1n : 0n, bytes });
      return { bytes, calc };
    }
    case 'sint32':
    case 'sint64': {
      const bits = type === 'sint32' ? 32 : 64;
      const z = zigzagEncode(v as bigint, bits);
      calc.push({ kind: 'zigzag', input: v as bigint, output: z, bits });
      const bytes = encodeVarint(z);
      calc.push({ kind: 'varint', value: z, bytes });
      return { bytes, calc };
    }
    case 'int32':
    case 'int64':
    case 'uint32':
    case 'uint64': {
      const n = v as bigint;
      if (n < 0n) calc.push({ kind: 'twos', input: n, output: BigInt.asUintN(64, n) });
      const bytes = encodeVarint(n);
      calc.push({ kind: 'varint', value: BigInt.asUintN(64, n), bytes });
      return { bytes, calc };
    }
    case 'fixed32':
    case 'sfixed32':
    case 'float':
    case 'fixed64':
    case 'sfixed64':
    case 'double': {
      const bytes = encodeFixed(type as Parameters<typeof encodeFixed>[0], v as bigint | number);
      calc.push({
        kind: 'fixed',
        type,
        display: typeof v === 'number' ? formatFloat(v) : String(v),
        bytes,
      });
      return { bytes, calc };
    }
  }
  throw new Error(`unsupported type ${type}`);
}

interface Encoded {
  bytes: number[];
  nodes: TraceNode[];
}

function tagCalc(fieldNumber: number, wt: WireType) {
  const tag = makeTag(fieldNumber, wt);
  const bytes = encodeVarint(tag);
  return { tag, bytes, calc: { kind: 'tag', fieldNumber, wireType: wt, value: tag, bytes } as Calc };
}

/** Write one tagged record (tag [+ len] + payload). Children offsets are relative to payload start. */
function record(
  opts: {
    fieldNumber: number;
    wireType: WireType;
    payload: number[];
    payloadCalc: Calc[];
    children?: TraceNode[];
    path: string;
    label: string;
    field?: FieldDef;
    typeName: string;
    display: string;
    depth: number;
    notes?: string[];
    messageType?: string;
  },
): Encoded {
  const t = tagCalc(opts.fieldNumber, opts.wireType);
  const out: number[] = [...t.bytes];
  const node: TraceNode = {
    id: nextId('e'),
    kind: 'field',
    path: opts.path,
    label: opts.label,
    field: opts.field,
    fieldNumber: opts.fieldNumber,
    wireType: opts.wireType,
    typeName: opts.typeName,
    start: 0,
    end: 0,
    tag: { start: 0, end: t.bytes.length, value: t.tag },
    display: opts.display,
    calc: [t.calc],
    notes: opts.notes ?? [],
    status: 'ok',
    depth: opts.depth,
    messageType: opts.messageType,
  };
  if (opts.wireType === WireType.LEN) {
    const lenBytes = encodeVarint(BigInt(opts.payload.length));
    node.len = { start: out.length, end: out.length + lenBytes.length, value: opts.payload.length };
    node.calc.push({ kind: 'len', length: opts.payload.length, bytes: lenBytes });
    out.push(...lenBytes);
  }
  const payloadStart = out.length;
  node.value = { start: payloadStart, end: payloadStart + opts.payload.length };
  node.calc.push(...opts.payloadCalc);
  out.push(...opts.payload);
  node.end = out.length;
  if (opts.children) {
    opts.children.forEach((c) => shiftNode(c, payloadStart));
    node.children = opts.children;
  }
  return { bytes: out, nodes: [node] };
}

function skipped(field: FieldDef, path: string, depth: number, display: string, note: string): TraceNode {
  return {
    id: nextId('e'),
    kind: 'skipped',
    path,
    label: field.name,
    field,
    fieldNumber: field.number,
    typeName: field.displayType,
    start: 0,
    end: 0,
    display,
    calc: [],
    notes: [note],
    status: 'skipped',
    depth,
  };
}

function concat(parts: Encoded[]): Encoded {
  const bytes: number[] = [];
  const nodes: TraceNode[] = [];
  for (const p of parts) {
    p.nodes.forEach((n) => shiftNode(n, bytes.length));
    bytes.push(...p.bytes);
    nodes.push(...p.nodes);
  }
  return { bytes, nodes };
}

function defaultDisplay(ctx: Ctx, f: FieldDef): string {
  if (f.map) return '{}';
  if (f.repeated) return '[]';
  if (f.kind === 'message') return 'not set';
  if (f.kind === 'enum') {
    const e = ctx.schema.enums.get(f.type);
    const name = e?.byNumber.get(0);
    return name ? `${name} (0)` : '0';
  }
  switch (f.type) {
    case 'string':
      return '""';
    case 'bytes':
      return '(empty)';
    case 'bool':
      return 'false';
    case 'float':
    case 'double':
      return '0.0';
    default:
      return '0';
  }
}

function encodeMessage(ctx: Ctx, msg: MessageDef, value: unknown, path: string, depth: number): Encoded {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    ctx.err(path || '(root)', `expected a JSON object for message ${msg.name}`);
    return { bytes: [], nodes: [] };
  }
  const obj = value as Record<string, unknown>;
  const p = (name: string) => (path ? `${path}.${name}` : name);

  for (const key of Object.keys(obj)) {
    if (!msg.byName.has(key)) {
      ctx.err(p(key), `message ${msg.name} has no field named "${key}"`);
    }
  }
  for (const o of msg.oneofs) {
    const set = o.fields.filter((f) => obj[f] !== undefined && obj[f] !== null);
    if (set.length > 1) {
      ctx.err(path || '(root)', `oneof "${o.name}" can hold only one field, but ${set.join(' and ')} are set`);
    }
  }

  const parts: Encoded[] = [];
  for (const f of msg.fields) {
    const fp = p(f.name);
    const raw = obj[f.name];
    if (raw === undefined || raw === null) {
      const why = f.oneof
        ? `not the active member of oneof \`${f.oneof}\` — nothing written`
        : f.hasPresence
          ? 'not set — nothing written (the reader will see has_' + f.name + '() = false)'
          : 'not set — nothing written; the reader will see the default value';
      parts.push({ bytes: [], nodes: [skipped(f, fp, depth, f.hasPresence && !f.repeated ? 'not set' : defaultDisplay(ctx, f), why)] });
      continue;
    }
    try {
      parts.push(encodeField(ctx, f, raw, fp, depth));
    } catch (e) {
      if (e instanceof ConvertError) {
        ctx.err(fp, e.message);
      } else throw e;
    }
  }
  return concat(parts);
}

function encodeField(ctx: Ctx, f: FieldDef, raw: unknown, fp: string, depth: number): Encoded {
  // ---- map<K, V> -------------------------------------------------------
  if (f.map) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new ConvertError(`expected a JSON object for ${f.displayType}`);
    }
    const entries = Object.entries(raw as Record<string, unknown>);
    if (!entries.length) {
      return { bytes: [], nodes: [skipped(f, fp, depth, '{}', 'empty map — nothing written')] };
    }
    const keyField = { type: f.map.keyType, kind: 'scalar' as const };
    const valField = { type: f.map.valueType, kind: f.map.valueKind };
    const recs: Encoded[] = [];
    for (const [k, v] of entries) {
      const ep = `${fp}[${JSON.stringify(k)}]`;
      let keyVal: Scalar;
      if (f.map.keyType === 'string') keyVal = k;
      else if (f.map.keyType === 'bool') keyVal = convertScalar(ctx, keyField, k);
      else keyVal = convertScalar(ctx, keyField, /^-?\d+$/.test(k) ? k : NaN);
      const keyPayload = encodeScalarPayload(ctx, f.map.keyType, 'scalar', keyVal);
      const keyRec = record({
        fieldNumber: 1,
        wireType: wireTypeFor(f.map.keyType, 'scalar'),
        payload: keyPayload.bytes,
        payloadCalc: keyPayload.calc,
        path: `${ep}.key`,
        label: 'key',
        typeName: f.map.keyType,
        display: displayScalar(ctx, f.map.keyType, 'scalar', keyVal),
        depth: depth + 2,
      });
      let valRec: Encoded;
      if (f.map.valueKind === 'message') {
        const inner = encodeMessage(ctx, ctx.schema.messages.get(f.map.valueType)!, v, `${ep}.value`, depth + 3);
        valRec = record({
          fieldNumber: 2,
          wireType: WireType.LEN,
          payload: inner.bytes,
          payloadCalc: [],
          children: inner.nodes,
          path: `${ep}.value`,
          label: 'value',
          typeName: shortName(f.map.valueType, ctx.schema.packageName),
          display: `{…} ${inner.bytes.length} B`,
          depth: depth + 2,
          messageType: f.map.valueType,
        });
      } else {
        const sv = convertScalar(ctx, valField, v);
        const vp = encodeScalarPayload(ctx, f.map.valueType, f.map.valueKind, sv);
        valRec = record({
          fieldNumber: 2,
          wireType: wireTypeFor(f.map.valueType, f.map.valueKind),
          payload: vp.bytes,
          payloadCalc: vp.calc,
          path: `${ep}.value`,
          label: 'value',
          typeName: shortName(f.map.valueType, ctx.schema.packageName),
          display: displayScalar(ctx, f.map.valueType, f.map.valueKind, sv),
          depth: depth + 2,
        });
      }
      const entry = concat([keyRec, valRec]);
      recs.push(
        record({
          fieldNumber: f.number,
          wireType: WireType.LEN,
          payload: entry.bytes,
          payloadCalc: [],
          children: entry.nodes,
          path: ep,
          label: `[${JSON.stringify(k)}]`,
          field: f,
          typeName: 'map entry',
          display: `${JSON.stringify(k)} → ${valRec.nodes[0].display}`,
          depth: depth + 1,
          notes: ['A map entry is encoded exactly like a nested message { key = 1; value = 2; }.'],
        }),
      );
    }
    return group(f, fp, depth, recs, `${entries.length} entr${entries.length > 1 ? 'ies' : 'y'}`, [
      'Maps have no special wire format: each entry is a separate LEN record with the map field number.',
    ]);
  }

  // ---- repeated -----------------------------------------------------------
  if (f.repeated) {
    if (!Array.isArray(raw)) throw new ConvertError(`expected a JSON array for ${f.displayType}`);
    if (!raw.length) {
      return { bytes: [], nodes: [skipped(f, fp, depth, '[]', 'empty repeated field — nothing written')] };
    }
    if (f.packed) {
      const elems: Encoded[] = raw.map((item, i) => {
        let sv: Scalar;
        try {
          sv = convertScalar(ctx, f, item);
        } catch (e) {
          throw new ConvertError(`[${i}]: ${(e as Error).message}`);
        }
        const pl = encodeScalarPayload(ctx, f.type, f.kind, sv);
        return {
          bytes: pl.bytes,
          nodes: [
            {
              id: nextId('e'),
              kind: 'element',
              path: `${fp}[${i}]`,
              label: `[${i}]`,
              field: f,
              typeName: shortName(f.type, ctx.schema.packageName),
              start: 0,
              end: pl.bytes.length,
              value: { start: 0, end: pl.bytes.length },
              display: displayScalar(ctx, f.type, f.kind, sv),
              calc: pl.calc,
              notes: [],
              status: 'ok',
              depth: depth + 1,
            } satisfies TraceNode,
          ],
        };
      });
      const all = concat(elems);
      return record({
        fieldNumber: f.number,
        wireType: WireType.LEN,
        payload: all.bytes,
        payloadCalc: [],
        children: all.nodes,
        path: fp,
        label: f.name,
        field: f,
        typeName: f.displayType,
        display: `[${raw.length} values, packed]`,
        depth,
        notes: [
          `Packed encoding: one tag + one length, then the ${raw.length} values back to back (saves ${raw.length - 1} tag byte(s)).`,
        ],
      });
    }
    const recs = raw.map((item, i) => {
      try {
        return encodeSingle(ctx, f, item, `${fp}[${i}]`, `[${i}]`, depth + 1);
      } catch (e) {
        throw new ConvertError(`[${i}]: ${(e as Error).message}`);
      }
    });
    const packable = f.kind === 'enum' || !['string', 'bytes'].includes(f.type) && f.kind !== 'message';
    return group(f, fp, depth, recs, `${raw.length} item${raw.length > 1 ? 's' : ''}`, [
      packable
        ? 'Unpacked (packed=false): every element is written as its own record, repeating the tag.'
        : 'Strings, bytes and messages cannot be packed: each element is its own tagged LEN record.',
    ]);
  }

  // ---- singular -----------------------------------------------------------
  return encodeSingle(ctx, f, raw, fp, f.name, depth);
}

function group(f: FieldDef, fp: string, depth: number, recs: Encoded[], display: string, notes: string[]): Encoded {
  const all = concat(recs);
  return {
    bytes: all.bytes,
    nodes: [
      {
        id: nextId('e'),
        kind: 'group',
        path: fp,
        label: f.name,
        field: f,
        fieldNumber: f.number,
        typeName: f.displayType,
        start: 0,
        end: all.bytes.length,
        display,
        calc: [],
        children: all.nodes,
        notes,
        status: 'ok',
        depth,
      },
    ],
  };
}

function encodeSingle(ctx: Ctx, f: FieldDef, raw: unknown, fp: string, label: string, depth: number): Encoded {
  const inList = label.startsWith('[');
  if (f.kind === 'message') {
    const m = ctx.schema.messages.get(f.type)!;
    const inner = encodeMessage(ctx, m, raw, fp, depth + 1);
    return record({
      fieldNumber: f.number,
      wireType: WireType.LEN,
      payload: inner.bytes,
      payloadCalc: [],
      children: inner.nodes,
      path: fp,
      label,
      field: f,
      typeName: shortName(f.type, ctx.schema.packageName),
      display: inner.bytes.length ? `${m.name} {…}` : `${m.name} {} (empty)`,
      depth,
      messageType: f.type,
      notes: inner.bytes.length
        ? [`Nested message: ${m.name} is serialized on its own first, so its length (${inner.bytes.length} bytes) is known and can prefix it.`]
        : ['An empty but *set* sub-message is still written (tag + length 0), so the reader knows it is present.'],
    });
  }
  const sv = convertScalar(ctx, f, raw);
  const display = displayScalar(ctx, f.type, f.kind, sv);
  if (!inList && !f.hasPresence && isDefault(sv)) {
    return {
      bytes: [],
      nodes: [
        skipped(
          f,
          fp,
          depth,
          display,
          `${display} is the default value — proto3 does not serialize it (implicit presence). The reader cannot tell "0" from "not set".`,
        ),
      ],
    };
  }
  const notes: string[] = [];
  if (!inList && f.hasPresence && isDefault(sv)) {
    notes.push(
      f.oneof
        ? `Default value, but written anyway: it is the active member of oneof \`${f.oneof}\`.`
        : 'Default value, but written anyway: `optional` gives the field explicit presence.',
    );
  }
  if (typeof sv === 'number' && Object.is(sv, -0)) {
    notes.push('-0.0 is not the default: its sign bit is set, so it is serialized.');
  }
  if ((f.type === 'int32' || f.type === 'int64' || f.kind === 'enum') && typeof sv === 'bigint' && sv < 0n) {
    notes.push('Negative int32/int64 values are sign-extended to 64 bits → always 10 bytes. Use sint32/sint64 for negative numbers.');
  }
  const pl = encodeScalarPayload(ctx, f.type, f.kind, sv);
  return record({
    fieldNumber: f.number,
    wireType: wireTypeFor(f.type, f.kind),
    payload: pl.bytes,
    payloadCalc: pl.calc,
    path: fp,
    label,
    field: f,
    typeName: shortName(f.type, ctx.schema.packageName),
    display,
    depth,
    notes,
  });
}

export function encode(schema: Schema, typeName: string, value: unknown): EncodeResult {
  const ctx = new Ctx(schema);
  const msg = schema.messages.get(typeName);
  if (!msg) {
    return { bytes: new Uint8Array(), nodes: [], errors: [{ path: '(root)', message: `unknown message type ${typeName}` }], typeName };
  }
  const res = encodeMessage(ctx, msg, value, '', 0);
  return { bytes: Uint8Array.from(res.bytes), nodes: res.nodes, errors: ctx.errors, typeName };
}
