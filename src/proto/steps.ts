/** Builds the animation timeline from the encoding and decoding traces. */
import type { DecodeResult, DecodedMessage } from './decoder';
import type { EncodeResult } from './encoder';
import type { Calc, Range, TraceNode } from './trace';
import { WIRE_TYPE_NAMES } from './types';
import { hexByte } from './wire';

export type Phase = 'encode' | 'transmit' | 'decode' | 'done';

export interface Step {
  phase: Phase;
  title: string;
  detail: string[];
  status: 'info' | 'ok' | 'skipped' | 'unknown' | 'warn' | 'error';
  producerNodeId?: string;
  consumerPath?: string;
  consumerNodeId?: string;
  range?: Range;
  /** Bytes present in the producer buffer at this step. */
  emitted: number;
  /** Bytes consumed by the reader at this step (-1 = nothing received yet). */
  consumed: number;
  calc: Calc[];
}

const isValueCalc = (c: Calc) => c.kind !== 'tag' && c.kind !== 'len';

function tagHex(n: TraceNode) {
  const c = n.calc.find((x) => x.kind === 'tag');
  return c && c.kind === 'tag' ? c.bytes.map(hexByte).join(' ') : '';
}

function encodeSteps(nodes: TraceNode[], out: Step[], total: number) {
  for (const n of nodes) {
    const base = { phase: 'encode' as const, producerNodeId: n.id, consumed: -1 };
    if (n.kind === 'skipped') {
      out.push({ ...base, title: `Skip \`${n.label}\``, detail: n.notes, status: 'skipped', emitted: current(out), calc: [] });
      continue;
    }
    if (n.kind === 'group') {
      out.push({
        ...base,
        title: `\`${n.label}\` (${n.typeName}): ${n.display}`,
        detail: n.notes,
        status: 'info',
        emitted: n.start,
        calc: [],
      });
      encodeSteps(n.children ?? [], out, total);
      continue;
    }
    if (n.kind === 'element') {
      out.push({
        ...base,
        title: `Element ${n.label} = ${n.display}`,
        detail: ['Packed elements have no tag of their own. The encoded values follow one another.'],
        status: 'ok',
        emitted: n.end,
        range: { start: n.start, end: n.end },
        calc: n.calc,
      });
      continue;
    }
    // tagged record
    const tag = n.tag!;
    out.push({
      ...base,
      title: `\`${n.label}\` → tag ${tagHex(n)}`,
      detail: [
        `Field number **${n.fieldNumber}**, wire type **${n.wireType} (${WIRE_TYPE_NAMES[n.wireType!]})**. Only the field number is sent, never its name.`,
      ],
      status: 'ok',
      emitted: tag.end,
      range: { start: tag.start, end: tag.end },
      calc: n.calc.filter((c) => c.kind === 'tag'),
    });
    if (n.children) {
      out.push({
        ...base,
        title: `\`${n.label}\` → length ${n.len!.value}`,
        detail: n.notes.length ? n.notes : ['Length-delimited record: the length prefix tells the reader how many bytes belong to it.'],
        status: 'ok',
        emitted: n.len!.end,
        range: { start: n.len!.start, end: n.len!.end },
        calc: n.calc.filter((c) => c.kind === 'len'),
      });
      encodeSteps(n.children, out, total);
    } else {
      out.push({
        ...base,
        title: `\`${n.label}\` = ${n.display}`,
        detail: n.len
          ? [`${n.len.value} byte(s) of payload, prefixed by their length.`, ...n.notes]
          : n.notes.length
            ? n.notes
            : [valueHint(n)],
        status: n.notes.some((x) => x.startsWith('Default value')) ? 'warn' : 'ok',
        emitted: n.end,
        range: { start: n.len ? n.len.start : n.value!.start, end: n.end },
        calc: n.calc.filter((c) => c.kind === 'len' || isValueCalc(c)),
      });
    }
  }
  void total;
}

function valueHint(n: TraceNode): string {
  switch (n.wireType) {
    case 0:
      return 'VARINT: 7 bits per byte, least-significant group first; the high bit (MSB) says "more bytes follow".';
    case 1:
      return 'I64: always 8 bytes, little-endian.';
    case 5:
      return 'I32: always 4 bytes, little-endian.';
    default:
      return '';
  }
}

function current(out: Step[]): number {
  for (let i = out.length - 1; i >= 0; i--) if (out[i].phase === 'encode') return out[i].emitted;
  return 0;
}

function decodeSteps(nodes: TraceNode[], out: Step[], total: number, typeName: string) {
  for (const n of nodes) {
    const base = { phase: 'decode' as const, emitted: total, consumerPath: n.path, consumerNodeId: n.id };
    if (n.kind === 'error') {
      out.push({
        ...base,
        title: 'Parse error',
        detail: [n.display, 'The whole message is rejected: `parseFrom()` throws `InvalidProtocolBufferException` (Java) / `ParseFromString` returns false (C++).'],
        status: 'error',
        consumed: n.end,
        range: { start: n.start, end: n.end },
        calc: [],
      });
      continue;
    }
    if (n.kind === 'element') {
      out.push({
        ...base,
        title: `Element ${n.label} = ${n.display}`,
        detail: n.notes.length ? n.notes : ['Read one value from the packed run.'],
        status: n.status === 'warn' ? 'warn' : 'ok',
        consumed: n.end,
        range: { start: n.start, end: n.end },
        calc: n.calc,
      });
      continue;
    }
    const tag = n.tag!;
    const lookup =
      n.kind === 'unknown' && !n.field
        ? `Look up field **#${n.fieldNumber}** in the consumer's \`${typeName}\`: **not found**.`
        : n.field
          ? `Look up field **#${n.fieldNumber}** in the consumer schema → \`${n.field.name}\` (${n.field.displayType}).`
          : '';
    out.push({
      ...base,
      title: `Read tag ${tagHex(n)} → field #${n.fieldNumber}, ${WIRE_TYPE_NAMES[n.wireType!]}`,
      detail: [lookup],
      status: n.kind === 'unknown' ? (n.status === 'warn' ? 'warn' : 'unknown') : 'ok',
      consumed: tag.end,
      range: { start: tag.start, end: tag.end },
      calc: n.calc.filter((c) => c.kind === 'tag'),
    });
    if (n.kind === 'unknown') {
      out.push({
        ...base,
        title: `Skip ${n.end - tag.end} byte(s) of unknown field #${n.fieldNumber}`,
        detail: [...n.notes, `Raw content: ${n.display}.`, 'The wire type tells the parser how many bytes to skip, which is what makes forward compatibility possible.'],
        status: n.status === 'warn' ? 'warn' : 'unknown',
        consumed: n.end,
        range: { start: tag.end, end: n.end },
        calc: n.calc.filter((c) => c.kind === 'len'),
      });
      continue;
    }
    if (n.children) {
      const hasErr = n.status === 'error';
      out.push({
        ...base,
        title: `\`${n.label}\` → ${n.len!.value} byte(s) to parse`,
        detail: n.notes,
        status: n.status === 'warn' && !hasErr ? 'warn' : 'ok',
        consumed: n.len!.end,
        range: { start: n.len!.start, end: n.len!.end },
        calc: n.calc.filter((c) => c.kind === 'len'),
      });
      decodeSteps(n.children, out, total, n.messageType ? n.messageType.split('.').pop()! : typeName);
      continue;
    }
    out.push({
      ...base,
      title: `\`${n.label}\` = ${n.display}`,
      detail: n.notes.length ? n.notes : [n.len ? `${n.len.value} payload byte(s).` : valueHint(n)],
      status: n.status === 'warn' ? 'warn' : n.status === 'error' ? 'error' : 'ok',
      consumed: n.end,
      range: { start: n.len ? n.len.start : n.value!.start, end: n.end },
      calc: n.calc.filter((c) => c.kind === 'len' || isValueCalc(c)),
    });
  }
}

export interface Summary {
  unknown: number;
  defaults: string[];
  warnings: number;
  present: number;
}

export function summarize(msg: DecodedMessage | null, nodes: TraceNode[]): Summary {
  const s: Summary = { unknown: 0, defaults: [], warnings: 0, present: 0 };
  const visitNodes = (ns: TraceNode[]) =>
    ns.forEach((n) => {
      if (n.kind === 'unknown') s.unknown++;
      if (n.status === 'warn') s.warnings++;
      if (n.children) visitNodes(n.children);
    });
  visitNodes(nodes);
  if (msg) {
    for (const f of msg.fields) {
      if (f.state === 'present') s.present++;
      else s.defaults.push(f.def.name);
    }
  }
  return s;
}

export function buildSteps(opts: {
  enc: EncodeResult | null;
  dec: DecodeResult | null;
  bytes: Uint8Array;
  override: boolean;
  producerType: string;
  consumerType: string;
}): Step[] {
  const { enc, dec, bytes, override } = opts;
  const total = bytes.length;
  const steps: Step[] = [];
  if (override || !enc) {
    steps.push({
      phase: 'encode',
      title: 'Hand-crafted bytes',
      detail: [
        'The bytes on the wire were typed by hand (see *Edit bytes*), not produced by the producer encoder.',
        'Use this to simulate buggy writers, truncation, concatenation or duplicate fields.',
      ],
      status: 'info',
      emitted: total,
      consumed: -1,
      calc: [],
    });
  } else {
    steps.push({
      phase: 'encode',
      title: `Serialize \`${short(opts.producerType)}\``,
      detail: [
        'The producer walks its schema in **field-number order**. Every field that is set becomes a *record*: a tag (field number + wire type) followed by the value.',
      ],
      status: 'info',
      emitted: 0,
      consumed: -1,
      calc: [],
    });
    encodeSteps(enc.nodes, steps, total);
    steps.push({
      phase: 'encode',
      title: `Serialized: ${total} byte${total === 1 ? '' : 's'}`,
      detail: total
        ? ['The message ends here. It has no header, field names, type name or schema, only records back to back.']
        : ['An empty message (all fields default) serializes to **zero bytes**.'],
      status: 'ok',
      emitted: total,
      consumed: -1,
      calc: [],
    });
  }
  steps.push({
    phase: 'transmit',
    title: `Send ${total} byte${total === 1 ? '' : 's'}`,
    detail: [
      'Only raw bytes travel (Kafka record, HTTP body, gRPC frame, file…). The consumer must bring **its own** `.proto` to interpret them, possibly a different version.',
    ],
    status: 'info',
    emitted: total,
    consumed: 0,
    calc: [],
  });
  if (dec) {
    steps.push({
      phase: 'decode',
      title: `Parse as \`${short(opts.consumerType)}\``,
      detail: ['The consumer reads records one at a time: tag → look up the field number in *its* schema → read the value according to the wire type.'],
      status: 'info',
      emitted: total,
      consumed: 0,
      calc: [],
    });
    decodeSteps(dec.nodes, steps, total, short(opts.consumerType));
    const s = summarize(dec.message, dec.nodes);
    const detail: string[] = [];
    if (dec.ok) {
      detail.push(`${s.present} field(s) read from the wire.`);
      if (s.defaults.length) {
        detail.push(
          `Absent from the wire → default values / not set: ${s.defaults.map((d) => `\`${d}\``).join(', ')}. The reader cannot tell "absent" from "default" unless the field has presence.`,
        );
      }
      if (s.unknown) detail.push(`${s.unknown} unknown record(s) kept aside as unknown fields.`);
      if (s.warnings) detail.push(`${s.warnings} warning(s): check the highlighted fields.`);
    } else {
      detail.push(dec.error!.message);
    }
    // Title and status must agree, since the status drives the card colour.
    const [title, status]: [string, Step['status']] = !dec.ok
      ? ['Parsing failed', 'error']
      : s.warnings
        ? ['Decoded with warnings', 'warn']
        : s.unknown
          ? ['Decoded, with unknown fields', 'unknown']
          : ['Decoded successfully', 'ok'];
    steps.push({
      phase: 'done',
      title,
      detail,
      status,
      emitted: total,
      consumed: dec.ok ? total : dec.error!.end,
      calc: [],
    });
  }
  return steps;
}

function short(t: string) {
  return t.split('.').pop() ?? t;
}
