/**
 * Proto3 decoder that interprets bytes with the *consumer's* schema and keeps
 * a detailed trace: unknown fields, wire-type mismatches, overwritten values,
 * unrecognized enum numbers, truncations, defaults filled in, etc.
 */
import { displayScalar } from './encoder';
import { shortName } from './schema';
import { nextId, type Calc, type TraceNode } from './trace';
import { WIRE_TYPE_NAMES, WireType, type FieldDef, type MessageDef, type Schema, type ScalarType } from './types';
import {
  MAX_FIELD_NUMBER,
  Reader,
  WireError,
  formatFloat,
  readFixed,
  toHex,
  utf8DecodeStrict,
  wireTypeFor,
  zigzagDecode,
} from './wire';

type Scalar = bigint | number | boolean | string | Uint8Array;

export type DValue =
  | { k: 'scalar'; v: Scalar; display: string }
  | { k: 'message'; msg: DecodedMessage }
  | { k: 'list'; items: DValue[] }
  | { k: 'map'; entries: { key: Scalar; keyDisplay: string; value: DValue }[] };

export interface DecodedField {
  def: FieldDef;
  /** present: read from the wire; default: absent, implicit default; unset: absent, has presence. */
  state: 'present' | 'default' | 'unset';
  value: DValue | null;
  display: string;
  nodeIds: string[];
  notes: string[];
  status: 'ok' | 'warn' | 'error';
}

export interface DecodedMessage {
  type: MessageDef;
  fields: DecodedField[];
  unknown: TraceNode[];
}

export interface DecodeResult {
  ok: boolean;
  error?: { message: string; offset: number; end: number };
  nodes: TraceNode[];
  message: DecodedMessage | null;
  typeName: string;
}

interface Slot {
  def: FieldDef;
  value: DValue;
  nodeIds: string[];
  notes: string[];
  status: 'ok' | 'warn' | 'error';
}

interface Acc {
  type: MessageDef;
  slots: Map<number, Slot>;
  unknown: TraceNode[];
  path: string;
}

const RESULT_NOTE_UNKNOWN =
  'Not in the consumer schema: skipped, but kept as an *unknown field* (since protobuf 3.5) so it survives re-serialization.';

class Decoder {
  constructor(public schema: Schema, public buf: Uint8Array) {}

  typeLabel(t: string) {
    return shortName(t, this.schema.packageName);
  }

  /** Decode [start, end) into `acc`, returning the trace nodes in wire order. */
  decodeInto(acc: Acc, start: number, end: number, depth: number, out: TraceNode[]): void {
    const r = new Reader(this.buf, start, end);
    while (!r.done) {
      const recStart = r.pos;
      const tag = r.varint();
      const tagEnd = r.pos;
      const fieldNumber = Number(tag >> 3n);
      const wt = Number(tag & 7n) as WireType;
      if (fieldNumber === 0 || fieldNumber > MAX_FIELD_NUMBER) {
        throw new WireError(
          `Invalid tag 0x${tag.toString(16)}: field number ${fieldNumber} is out of range (1 … 2^29-1)`,
          recStart,
          tagEnd,
        );
      }
      if (wt === WireType.SGROUP || wt === WireType.EGROUP) {
        throw new WireError(
          `Wire type ${wt} (${WIRE_TYPE_NAMES[wt]}) is a deprecated proto2 group, not supported in proto3`,
          recStart,
          tagEnd,
        );
      }
      if (wt > 5) {
        throw new WireError(`Invalid wire type ${wt} in tag 0x${tag.toString(16)} (valid: 0, 1, 2, 5)`, recStart, tagEnd);
      }
      const tagCalc: Calc = {
        kind: 'tag',
        fieldNumber,
        wireType: wt,
        value: tag,
        bytes: Array.from(this.buf.subarray(recStart, tagEnd)),
      };

      // --- read the raw payload according to the wire type -------------------
      let len: TraceNode['len'];
      let valueStart = r.pos;
      let raw: bigint | Uint8Array;
      const lenCalc: Calc[] = [];
      if (wt === WireType.VARINT) {
        raw = r.varint();
      } else if (wt === WireType.I64) {
        raw = r.bytes(8);
      } else if (wt === WireType.I32) {
        raw = r.bytes(4);
      } else {
        const lStart = r.pos;
        const l = r.varint();
        if (l > BigInt(end - r.pos)) {
          throw new WireError(
            `Length prefix says ${l} bytes but only ${end - r.pos} remain. The message is truncated or corrupt`,
            recStart,
            end,
          );
        }
        len = { start: lStart, end: r.pos, value: Number(l) };
        lenCalc.push({ kind: 'len', length: Number(l), bytes: Array.from(this.buf.subarray(lStart, r.pos)) });
        valueStart = r.pos;
        raw = r.bytes(Number(l));
      }
      const valueEnd = r.pos;

      const node: TraceNode = {
        id: nextId('d'),
        kind: 'field',
        path: '',
        label: `#${fieldNumber}`,
        fieldNumber,
        wireType: wt,
        typeName: WIRE_TYPE_NAMES[wt],
        start: recStart,
        end: valueEnd,
        tag: { start: recStart, end: tagEnd, value: tag },
        len,
        value: { start: valueStart, end: valueEnd },
        display: '',
        calc: [tagCalc, ...lenCalc],
        notes: [],
        status: 'ok',
        depth,
      };
      out.push(node);

      const def = acc.type.byNumber.get(fieldNumber);
      if (!def) {
        this.markUnknown(acc, node, raw, wt);
        continue;
      }
      node.field = def;
      node.label = def.name;
      node.typeName = def.displayType;

      const expected = def.map ? WireType.LEN : wireTypeFor(def.type, def.kind);
      const packedOk = def.repeated && wt === WireType.LEN && expected !== WireType.LEN;
      if (wt !== expected && !packedOk) {
        node.kind = 'unknown';
        node.status = 'warn';
        node.notes.push(
          `Wire type mismatch: \`${def.name}\` (${def.displayType}) expects ${WIRE_TYPE_NAMES[expected]} but the record is ${WIRE_TYPE_NAMES[wt]}. ` +
            'The parser cannot interpret it, so it is treated as an unknown field (C++/Java behaviour; some libraries throw instead).',
        );
        node.display = this.rawDisplay(raw, wt);
        node.path = this.p(acc.path, def.name);
        acc.unknown.push(node);
        continue;
      }

      this.assign(acc, def, node, raw, wt, depth);
    }
  }

  p(base: string, name: string) {
    return base ? `${base}.${name}` : name;
  }

  markUnknown(acc: Acc, node: TraceNode, raw: bigint | Uint8Array, wt: WireType) {
    node.kind = 'unknown';
    node.status = 'unknown';
    node.label = `#${node.fieldNumber}`;
    node.display = this.rawDisplay(raw, wt);
    node.path = this.p(acc.path, `#${node.fieldNumber}`);
    const reserved = acc.type.reservedNumbers.some(([a, b]) => node.fieldNumber! >= a && node.fieldNumber! <= b);
    node.notes.push(`Field number ${node.fieldNumber} does not exist in ${acc.type.name}. ${RESULT_NOTE_UNKNOWN}`);
    if (reserved) node.notes.push(`${node.fieldNumber} is \`reserved\` in the consumer schema: it belonged to a deleted field.`);
    acc.unknown.push(node);
  }

  rawDisplay(raw: bigint | Uint8Array, wt: WireType): string {
    if (typeof raw === 'bigint') return `varint ${raw}`;
    if (wt === WireType.LEN) {
      const text = utf8DecodeStrict(raw);
      const printable = text !== null && raw.length > 0 && /^[\p{L}\p{N}\p{P}\p{S}\p{Zs}]+$/u.test(text);
      return printable ? `${raw.length} B · "${text}"` : `${raw.length} B · ${toHex(raw) || '(empty)'}`;
    }
    return `0x${toHex(raw, '')} (${wt === WireType.I64 ? '64' : '32'}-bit)`;
  }

  /** Interpret a scalar payload with the consumer's declared type. */
  scalar(def: { type: string; kind: FieldDef['kind'] }, raw: bigint | Uint8Array, node: TraceNode, name: string): Scalar {
    const calc = node.calc;
    if (def.kind === 'enum') {
      const v = BigInt.asIntN(32, raw as bigint);
      calc.push({ kind: 'varint', value: raw as bigint, bytes: Array.from(this.buf.subarray(node.value!.start, node.value!.end)) });
      this.truncNote(raw as bigint, v, 32, true, node, calc);
      const e = this.schema.enums.get(def.type)!;
      const known = e.byNumber.get(Number(v));
      calc.push({ kind: 'enum', enumName: e.name, name: known ?? null, number: Number(v) });
      if (!known) {
        node.status = 'warn';
        node.notes.push(
          `${v} is not a known value of enum ${e.name}. proto3 enums are *open*: the number is kept as-is (in Java: \`UNRECOGNIZED\`, getXxxValue() = ${v}).`,
        );
      }
      return v;
    }
    const t = def.type as ScalarType;
    if (raw instanceof Uint8Array) {
      switch (t) {
        case 'string': {
          const s = utf8DecodeStrict(raw);
          if (s === null) {
            throw new WireError(
              `Invalid UTF-8 in string field \`${name}\`: proto3 parsers reject the whole message (use \`bytes\` for binary data)`,
              node.value!.start,
              node.value!.end,
            );
          }
          calc.push({ kind: 'utf8', text: s, bytes: Array.from(raw) });
          return s;
        }
        case 'bytes':
          calc.push({ kind: 'bytes', bytes: Array.from(raw) });
          return raw.slice();
        default: {
          const v = readFixed(t, raw);
          calc.push({ kind: 'fixed', type: t, display: typeof v === 'number' ? formatFloat(v) : String(v), bytes: Array.from(raw) });
          return v;
        }
      }
    }
    const bytes = Array.from(this.buf.subarray(node.value!.start, node.value!.end));
    calc.push({ kind: 'varint', value: raw, bytes });
    switch (t) {
      case 'int32': {
        const v = BigInt.asIntN(32, raw);
        this.truncNote(raw, v, 32, true, node, calc);
        return v;
      }
      case 'uint32': {
        const v = BigInt.asUintN(32, raw);
        this.truncNote(raw, v, 32, false, node, calc);
        return v;
      }
      case 'int64': {
        const v = BigInt.asIntN(64, raw);
        if (v < 0n) calc.push({ kind: 'twos', input: v, output: raw });
        return v;
      }
      case 'uint64':
        return raw;
      case 'sint32':
      case 'sint64': {
        const bits = t === 'sint32' ? 32 : 64;
        const v = zigzagDecode(raw, bits);
        calc.push({ kind: 'zigzag', input: v, output: BigInt.asUintN(bits, raw), bits, decode: true });
        if (bits === 32 && BigInt.asUintN(32, raw) !== raw) {
          node.status = 'warn';
          node.notes.push('Value did not fit in 32 bits: upper bits were discarded.');
        }
        return v;
      }
      case 'bool': {
        const v = raw !== 0n;
        calc.push({ kind: 'bool', value: v, raw });
        if (raw > 1n) {
          node.status = 'warn';
          node.notes.push(`bool read from varint ${raw}: any non-zero value is \`true\`.`);
        }
        return v;
      }
    }
    throw new Error(`unexpected type ${t}`);
  }

  truncNote(raw: bigint, v: bigint, bits: number, signed: boolean, node: TraceNode, calc: Calc[]) {
    const wide = signed ? BigInt.asIntN(64, raw) : raw;
    if (wide !== v) {
      calc.push({ kind: 'truncate', from: wide, to: v, bits, signed });
      node.status = 'warn';
      node.notes.push(
        `${wide} does not fit in ${signed ? '' : 'u'}int${bits}: the value is silently truncated to its lower ${bits} bits → ${v}.`,
      );
    } else if (signed && v < 0n) {
      calc.push({ kind: 'twos', input: v, output: raw });
    }
  }

  assign(acc: Acc, def: FieldDef, node: TraceNode, raw: bigint | Uint8Array, wt: WireType, depth: number) {
    const fp = this.p(acc.path, def.name);
    let slot = acc.slots.get(def.number);

    // oneof: setting a member clears the others
    if (def.oneof) {
      for (const [num, other] of acc.slots) {
        if (num !== def.number && other.def.oneof === def.oneof) {
          acc.slots.delete(num);
          node.status = node.status === 'ok' ? 'warn' : node.status;
          node.notes.push(`Setting \`${def.name}\` clears \`${other.def.name}\`: both belong to oneof \`${def.oneof}\` and the last one on the wire wins.`);
        }
      }
    }

    // ---- map entry ---------------------------------------------------------
    if (def.map) {
      const m = def.map;
      const entryType: MessageDef = {
        kind: 'message',
        name: `${def.name} entry`,
        fullName: `${def.name}Entry`,
        fields: [],
        byNumber: new Map(),
        byName: new Map(),
        oneofs: [],
        reservedNumbers: [],
        reservedNames: [],
      };
      const keyDef: FieldDef = { name: 'key', number: 1, type: m.keyType, kind: 'scalar', repeated: false, packed: false, hasPresence: false, explicitOptional: false, displayType: m.keyType };
      const valDef: FieldDef = { name: 'value', number: 2, type: m.valueType, kind: m.valueKind, repeated: false, packed: false, hasPresence: m.valueKind === 'message', explicitOptional: false, displayType: this.typeLabel(m.valueType) };
      entryType.fields = [keyDef, valDef];
      entryType.byNumber = new Map([[1, keyDef], [2, valDef]]);
      entryType.byName = new Map([['key', keyDef], ['value', valDef]]);
      // decode the entry as a tiny message first to find the key
      const probe: Acc = { type: entryType, slots: new Map(), unknown: [], path: fp };
      const children: TraceNode[] = [];
      this.decodeInto(probe, node.value!.start, node.value!.end, depth + 1, children);
      const keySlot = probe.slots.get(1);
      const key: Scalar = keySlot ? (keySlot.value as { v: Scalar }).v : defaultScalar(m.keyType, 'scalar');
      const keyDisplay = displayScalar(this, m.keyType, 'scalar', key);
      const ep = `${fp}[${JSON.stringify(typeof key === 'bigint' ? String(key) : typeof key === 'boolean' ? String(key) : key)}]`;
      // fix up child paths now that the key is known
      const fix = (ns: TraceNode[], from: string, to: string) =>
        ns.forEach((n) => {
          if (n.path.startsWith(from)) n.path = to + n.path.slice(from.length);
          if (n.children) fix(n.children, from, to);
        });
      fix(children, fp, ep);
      let value: DValue;
      const valSlot = probe.slots.get(2);
      if (valSlot) value = valSlot.value;
      else if (m.valueKind === 'message') value = { k: 'message', msg: finalize({ type: this.schema.messages.get(m.valueType)!, slots: new Map(), unknown: [], path: `${ep}.value` }, this.schema) };
      else {
        const dv = defaultScalar(m.valueType, m.valueKind);
        value = { k: 'scalar', v: dv, display: displayScalar(this, m.valueType, m.valueKind, dv) };
      }
      node.children = children;
      node.path = ep;
      node.label = `${def.name}[${keyDisplay}]`;
      node.display = `${keyDisplay} → ${value.k === 'scalar' ? value.display : '{…}'}`;
      node.notes.push('Map entry: decoded as a mini message { key = 1; value = 2; }.');
      if (!keySlot) node.notes.push('No key on the wire → the key is the default value.');
      if (!slot) {
        slot = { def, value: { k: 'map', entries: [] }, nodeIds: [], notes: [], status: 'ok' };
        acc.slots.set(def.number, slot);
      }
      const entries = (slot.value as Extract<DValue, { k: 'map' }>).entries;
      const existing = entries.findIndex((e) => keyEq(e.key, key));
      if (existing >= 0) {
        entries[existing].value = value;
        node.status = 'warn';
        node.notes.push(`Duplicate key ${keyDisplay}: the last entry wins.`);
      } else {
        entries.push({ key, keyDisplay, value });
      }
      slot.nodeIds.push(node.id);
      return;
    }

    // ---- embedded message ------------------------------------------------------
    if (def.kind === 'message') {
      const m = this.schema.messages.get(def.type)!;
      node.messageType = def.type;
      if (def.repeated) {
        if (!slot) {
          slot = { def, value: { k: 'list', items: [] }, nodeIds: [], notes: [], status: 'ok' };
          acc.slots.set(def.number, slot);
        }
        const items = (slot.value as Extract<DValue, { k: 'list' }>).items;
        const ip = `${fp}[${items.length}]`;
        const sub: Acc = { type: m, slots: new Map(), unknown: [], path: ip };
        const children: TraceNode[] = [];
        node.children = children;
        node.path = ip;
        node.label = `${def.name}[${items.length}]`;
        node.display = `${m.name} {…}`;
        try {
          this.decodeInto(sub, node.value!.start, node.value!.end, depth + 1, children);
        } finally {
          items.push({ k: 'message', msg: finalize(sub, this.schema) });
          slot.nodeIds.push(node.id);
        }
      } else {
        let sub: Acc;
        if (slot && slot.value.k === 'message') {
          // merge: a second occurrence of a singular message field merges into the first
          sub = (slot.value.msg as DecodedMessage & { __acc: Acc }).__acc;
          node.status = 'warn';
          node.notes.push(
            `\`${def.name}\` appears again: for a singular *message* field, the new occurrence is **merged** into the existing one (scalars overwritten, repeated fields appended).`,
          );
        } else {
          sub = { type: m, slots: new Map(), unknown: [], path: fp };
          slot = { def, value: { k: 'message', msg: null as unknown as DecodedMessage }, nodeIds: [], notes: [], status: 'ok' };
          acc.slots.set(def.number, slot);
        }
        const children: TraceNode[] = [];
        node.children = children;
        node.path = fp;
        node.display = node.len!.value ? `${m.name} {…}` : `${m.name} {} (empty, but set)`;
        const target = slot;
        target.nodeIds.push(node.id);
        try {
          this.decodeInto(sub, node.value!.start, node.value!.end, depth + 1, children);
        } finally {
          const msg = finalize(sub, this.schema);
          (msg as DecodedMessage & { __acc: Acc }).__acc = sub;
          target.value = { k: 'message', msg };
        }
      }
      node.notes.push(`Nested message: the ${node.len!.value} payload bytes are parsed recursively as ${m.name}.`);
      return;
    }

    // ---- scalars / enums ----------------------------------------------------------
    if (def.repeated) {
      if (!slot) {
        slot = { def, value: { k: 'list', items: [] }, nodeIds: [], notes: [], status: 'ok' };
        acc.slots.set(def.number, slot);
      }
      const items = (slot.value as Extract<DValue, { k: 'list' }>).items;
      const packable = wireTypeFor(def.type, def.kind) !== WireType.LEN;
      if (wt === WireType.LEN && packable) {
        // packed run
        const r = new Reader(this.buf, node.value!.start, node.value!.end);
        const children: TraceNode[] = [];
        const ewt = wireTypeFor(def.type, def.kind);
        while (!r.done) {
          const s = r.pos;
          const eraw = ewt === WireType.VARINT ? r.varint() : r.bytes(ewt === WireType.I64 ? 8 : 4);
          const child: TraceNode = {
            id: nextId('d'),
            kind: 'element',
            path: `${fp}[${items.length}]`,
            label: `[${items.length}]`,
            field: def,
            typeName: this.typeLabel(def.type),
            start: s,
            end: r.pos,
            value: { start: s, end: r.pos },
            display: '',
            calc: [],
            notes: [],
            status: 'ok',
            depth: depth + 1,
          };
          const v = this.scalar(def, eraw, child, def.name);
          child.display = displayScalar(this, def.type, def.kind, v);
          children.push(child);
          items.push({ k: 'scalar', v, display: child.display });
          if (child.status === 'warn') node.status = 'warn';
        }
        node.children = children;
        node.path = fp;
        node.display = `[${children.length} packed values]`;
        node.notes.push(
          def.packed
            ? 'Packed repeated field: one LEN record containing all the values back to back.'
            : 'The consumer declares this field `[packed=false]` but parsers must accept both packed and unpacked forms.',
        );
      } else {
        const v = this.scalar(def, raw, node, def.name);
        node.path = `${fp}[${items.length}]`;
        node.label = `${def.name}[${items.length}]`;
        node.display = displayScalar(this, def.type, def.kind, v);
        items.push({ k: 'scalar', v, display: node.display });
        if (def.packed) node.notes.push('Unpacked element for a packed field: parsers accept both forms.');
      }
      slot.nodeIds.push(node.id);
      return;
    }

    const v = this.scalar(def, raw, node, def.name);
    node.path = fp;
    node.display = displayScalar(this, def.type, def.kind, v);
    if (slot && !def.oneof) {
      node.status = 'warn';
      node.notes.push(
        `\`${def.name}\` was already set to ${(slot.value as { display: string }).display}: for a singular scalar field the **last value wins**.`,
      );
    }
    if (typeof v === 'number' && Object.is(v, -0)) node.notes.push('-0.0 was on the wire, so it is kept distinct from 0.');
    const prevIds = slot && !def.oneof ? slot.nodeIds : [];
    acc.slots.set(def.number, {
      def,
      value: { k: 'scalar', v, display: node.display },
      nodeIds: [...prevIds, node.id],
      notes: [],
      status: node.status === 'warn' ? 'warn' : 'ok',
    });
  }
}

function keyEq(a: Scalar, b: Scalar) {
  return a === b || (typeof a === 'bigint' && typeof b === 'bigint' && a === b);
}

export function defaultScalar(type: string, kind: FieldDef['kind']): Scalar {
  if (kind === 'enum') return 0n;
  switch (type) {
    case 'string':
      return '';
    case 'bytes':
      return new Uint8Array();
    case 'bool':
      return false;
    case 'float':
    case 'double':
      return 0;
    default:
      return 0n;
  }
}

function finalize(acc: Acc, schema: Schema): DecodedMessage {
  const fields: DecodedField[] = acc.type.fields.map((def) => {
    const slot = acc.slots.get(def.number);
    if (slot) {
      let display = '';
      if (slot.value.k === 'scalar') display = slot.value.display;
      else if (slot.value.k === 'list') display = `[${slot.value.items.length}]`;
      else if (slot.value.k === 'map') display = `{${slot.value.entries.length}}`;
      else display = `${slot.value.msg.type.name} {…}`;
      return { def, state: 'present', value: slot.value, display, nodeIds: slot.nodeIds, notes: slot.notes, status: slot.status };
    }
    if (def.map) return { def, state: 'default', value: { k: 'map', entries: [] }, display: '{}', nodeIds: [], notes: [], status: 'ok' };
    if (def.repeated) return { def, state: 'default', value: { k: 'list', items: [] }, display: '[]', nodeIds: [], notes: [], status: 'ok' };
    if (def.kind === 'message') return { def, state: 'unset', value: null, display: 'not set', nodeIds: [], notes: [], status: 'ok' };
    const dv = defaultScalar(def.type, def.kind);
    const shown = displayScalar({ schema }, def.type, def.kind, dv);
    return {
      def,
      state: def.hasPresence ? 'unset' : 'default',
      value: { k: 'scalar', v: dv, display: shown },
      display: shown,
      nodeIds: [],
      notes: [],
      status: 'ok',
    };
  });
  return { type: acc.type, fields, unknown: acc.unknown };
}

export function decode(schema: Schema, typeName: string, bytes: Uint8Array): DecodeResult {
  const msg = schema.messages.get(typeName);
  if (!msg) {
    return { ok: false, error: { message: `unknown message type ${typeName}`, offset: 0, end: 0 }, nodes: [], message: null, typeName };
  }
  const d = new Decoder(schema, bytes);
  const acc: Acc = { type: msg, slots: new Map(), unknown: [], path: '' };
  const nodes: TraceNode[] = [];
  try {
    d.decodeInto(acc, 0, bytes.length, 0, nodes);
    return { ok: true, nodes, message: finalize(acc, schema), typeName };
  } catch (e) {
    if (!(e instanceof WireError)) throw e;
    const end = Math.max(e.end ?? bytes.length, e.offset + 1);
    // Drop partially-built nodes that overlap the failure and add an error marker.
    const errNode: TraceNode = {
      id: nextId('d'),
      kind: 'error',
      path: '',
      label: 'parse error',
      typeName: '',
      start: e.offset,
      end: Math.min(end, bytes.length),
      display: e.message,
      calc: [],
      notes: [e.message],
      status: 'error',
      depth: 0,
    };
    insertError(nodes, errNode);
    return {
      ok: false,
      error: { message: e.message, offset: e.offset, end: errNode.end },
      nodes,
      message: finalize(acc, schema),
      typeName,
    };
  }
}

/** Place the error node at the deepest open record containing it. */
function insertError(nodes: TraceNode[], err: TraceNode) {
  const last = nodes[nodes.length - 1];
  if (last && last.children && last.value && err.start >= last.value.start && err.start < last.value.end) {
    err.depth = last.depth + 1;
    insertError(last.children, err);
    last.status = 'error';
    return;
  }
  if (last && last.start <= err.start && err.start < last.end && !last.children) {
    last.status = 'error';
  }
  nodes.push(err);
}

/** Canonical-ish proto3 JSON of a decoded message. */
export function toJson(msg: DecodedMessage, includeDefaults: boolean, schema: Schema): unknown {
  const out: Record<string, unknown> = {};
  for (const f of msg.fields) {
    if (f.state !== 'present' && !includeDefaults) continue;
    if (f.state === 'unset' && f.def.kind === 'message') {
      if (includeDefaults) out[f.def.name] = null;
      continue;
    }
    out[f.def.name] = f.value ? jsonValue(f.value, f.def, schema, includeDefaults) : null;
  }
  return out;
}

function jsonScalar(v: Scalar, type: string, kind: FieldDef['kind'], schema: Schema): unknown {
  if (kind === 'enum') {
    const name = schema.enums.get(type)?.byNumber.get(Number(v));
    return name ?? Number(v);
  }
  if (typeof v === 'bigint') {
    return ['int64', 'uint64', 'sint64', 'fixed64', 'sfixed64'].includes(type) ? v.toString() : Number(v);
  }
  if (v instanceof Uint8Array) {
    let s = '';
    v.forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s);
  }
  if (typeof v === 'number' && !Number.isFinite(v)) return String(v);
  return v;
}

function jsonValue(v: DValue, def: FieldDef, schema: Schema, inc: boolean): unknown {
  switch (v.k) {
    case 'scalar':
      return jsonScalar(v.v, def.type, def.kind, schema);
    case 'message':
      return toJson(v.msg, inc, schema);
    case 'list':
      return v.items.map((i) => (i.k === 'message' ? toJson(i.msg, inc, schema) : i.k === 'scalar' ? jsonScalar(i.v, def.type, def.kind, schema) : null));
    case 'map': {
      const o: Record<string, unknown> = {};
      for (const e of v.entries) {
        const k = typeof e.key === 'string' ? e.key : String(e.key);
        o[k] =
          e.value.k === 'message'
            ? toJson(e.value.msg, inc, schema)
            : e.value.k === 'scalar'
              ? jsonScalar(e.value.v, def.map!.valueType, def.map!.valueKind, schema)
              : null;
      }
      return o;
    }
  }
}
