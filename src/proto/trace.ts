/** Shared shapes describing *how* bytes were produced / interpreted. */
import type { FieldDef } from './types';
import type { WireType } from './types';

export interface Range {
  start: number;
  end: number;
}

/** A small "worksheet" explaining one encoding computation. */
export type Calc =
  | { kind: 'tag'; fieldNumber: number; wireType: WireType; value: bigint; bytes: number[] }
  | { kind: 'varint'; value: bigint; bytes: number[] }
  | { kind: 'zigzag'; input: bigint; output: bigint; bits: 32 | 64; decode?: boolean }
  | { kind: 'twos'; input: bigint; output: bigint }
  | { kind: 'fixed'; type: string; display: string; bytes: number[] }
  | { kind: 'utf8'; text: string; bytes: number[] }
  | { kind: 'bytes'; bytes: number[] }
  | { kind: 'len'; length: number; bytes: number[] }
  | { kind: 'enum'; enumName: string; name: string | null; number: number }
  | { kind: 'bool'; value: boolean; raw?: bigint }
  | { kind: 'truncate'; from: bigint; to: bigint; bits: number; signed: boolean };

export type NodeStatus = 'ok' | 'skipped' | 'unknown' | 'warn' | 'error';

/**
 * One node in the annotated byte tree. The same shape is used for the
 * producer's encoding trace and for the consumer's decoding trace.
 */
export interface TraceNode {
  id: string;
  /**
   * field    — a tagged record on the wire
   * element  — a value inside a packed record (no tag of its own)
   * group    — logical grouping of several records (repeated / map field)
   * skipped  — field not written (producer) / absent from the wire (consumer)
   * unknown  — consumer: tag not in its schema
   * error    — consumer: where parsing failed
   */
  kind: 'field' | 'element' | 'group' | 'skipped' | 'unknown' | 'error';
  path: string;
  label: string;
  field?: FieldDef;
  fieldNumber?: number;
  wireType?: WireType;
  typeName: string;
  start: number;
  end: number;
  tag?: Range & { value: bigint };
  len?: Range & { value: number };
  value?: Range;
  display: string;
  calc: Calc[];
  children?: TraceNode[];
  notes: string[];
  status: NodeStatus;
  depth: number;
  /** Message type name for nested messages. */
  messageType?: string;
}

let counter = 0;
export function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function shiftNode(n: TraceNode, offset: number): void {
  n.start += offset;
  n.end += offset;
  if (n.tag) {
    n.tag.start += offset;
    n.tag.end += offset;
  }
  if (n.len) {
    n.len.start += offset;
    n.len.end += offset;
  }
  if (n.value) {
    n.value.start += offset;
    n.value.end += offset;
  }
  n.children?.forEach((c) => shiftNode(c, offset));
}

export function walk(nodes: TraceNode[], fn: (n: TraceNode, parent?: TraceNode) => void, parent?: TraceNode) {
  for (const n of nodes) {
    fn(n, parent);
    if (n.children) walk(n.children, fn, n);
  }
}

/** Byte-level annotation used by the hex views. */
export interface ByteInfo {
  /** Leaf-most node owning the byte. */
  node: TraceNode;
  /** Top-level node owning the byte (used for coloring). */
  root: TraceNode;
  role: 'tag' | 'len' | 'value';
}

export function annotateBytes(nodes: TraceNode[], length: number): (ByteInfo | null)[] {
  const out: (ByteInfo | null)[] = new Array(length).fill(null);
  const visit = (n: TraceNode, root: TraceNode) => {
    const mark = (r: Range | undefined, role: ByteInfo['role']) => {
      if (!r) return;
      for (let i = r.start; i < r.end && i < length; i++) out[i] = { node: n, root, role };
    };
    if (n.kind === 'unknown' || n.kind === 'error') {
      mark({ start: n.start, end: n.end }, 'value');
    }
    mark(n.tag, 'tag');
    mark(n.len, 'len');
    mark(n.value, 'value');
    n.children?.forEach((c) => visit(c, root));
  };
  nodes.forEach((n) => visit(n, n));
  return out;
}
