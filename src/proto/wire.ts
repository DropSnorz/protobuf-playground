/** Low-level wire-format helpers shared by the encoder and the decoder. */
import { WireType, type ScalarType } from './types';

export const MAX_FIELD_NUMBER = 536870911; // 2^29 - 1

export function wireTypeFor(type: string, kind: 'scalar' | 'enum' | 'message'): WireType {
  if (kind === 'enum') return WireType.VARINT;
  if (kind === 'message') return WireType.LEN;
  switch (type as ScalarType) {
    case 'double':
    case 'fixed64':
    case 'sfixed64':
      return WireType.I64;
    case 'float':
    case 'fixed32':
    case 'sfixed32':
      return WireType.I32;
    case 'string':
    case 'bytes':
      return WireType.LEN;
    default:
      return WireType.VARINT;
  }
}

export function encodeVarint(value: bigint): number[] {
  let v = BigInt.asUintN(64, value);
  const out: number[] = [];
  do {
    let byte = Number(v & 0x7fn);
    v >>= 7n;
    if (v !== 0n) byte |= 0x80;
    out.push(byte);
  } while (v !== 0n);
  return out;
}

export function zigzagEncode(value: bigint, bits: 32 | 64): bigint {
  const v = BigInt.asIntN(bits, value);
  return BigInt.asUintN(bits, (v << 1n) ^ (v >> BigInt(bits - 1)));
}

export function zigzagDecode(value: bigint, bits: 32 | 64): bigint {
  const v = BigInt.asUintN(bits, value);
  return (v >> 1n) ^ -(v & 1n);
}

export function makeTag(fieldNumber: number, wireType: WireType): bigint {
  return (BigInt(fieldNumber) << 3n) | BigInt(wireType);
}

export function encodeFixed(type: 'fixed32' | 'sfixed32' | 'float' | 'fixed64' | 'sfixed64' | 'double', value: bigint | number): number[] {
  const is64 = type === 'fixed64' || type === 'sfixed64' || type === 'double';
  const buf = new DataView(new ArrayBuffer(is64 ? 8 : 4));
  switch (type) {
    case 'fixed32':
      buf.setUint32(0, Number(BigInt.asUintN(32, BigInt(value))), true);
      break;
    case 'sfixed32':
      buf.setInt32(0, Number(BigInt.asIntN(32, BigInt(value))), true);
      break;
    case 'float':
      buf.setFloat32(0, Number(value), true);
      break;
    case 'fixed64':
      buf.setBigUint64(0, BigInt.asUintN(64, BigInt(value)), true);
      break;
    case 'sfixed64':
      buf.setBigInt64(0, BigInt.asIntN(64, BigInt(value)), true);
      break;
    case 'double':
      buf.setFloat64(0, Number(value), true);
      break;
  }
  return Array.from(new Uint8Array(buf.buffer));
}

export function utf8Encode(s: string): number[] {
  return Array.from(new TextEncoder().encode(s));
}

const strictDecoder = new TextDecoder('utf-8', { fatal: true });
export function utf8DecodeStrict(bytes: Uint8Array): string | null {
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

export class WireError extends Error {
  constructor(message: string, public offset: number, public end?: number) {
    super(message);
  }
}

export class Reader {
  pos: number;
  constructor(public buf: Uint8Array, start = 0, public end = buf.length) {
    this.pos = start;
  }

  get done() {
    return this.pos >= this.end;
  }

  varint(): bigint {
    const start = this.pos;
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.end) {
        throw new WireError('Truncated varint: ran out of bytes before a byte with MSB = 0', start, this.pos);
      }
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if ((b & 0x80) === 0) return BigInt.asUintN(64, result);
      shift += 7n;
    }
    throw new WireError('Malformed varint: longer than 10 bytes', start, this.pos);
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.end) {
      throw new WireError(
        `Truncated: needs ${n} byte(s) but only ${this.end - this.pos} left`,
        this.pos,
        this.end,
      );
    }
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
}

export function readFixed(type: string, bytes: Uint8Array): bigint | number {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (type) {
    case 'fixed32':
      return BigInt(dv.getUint32(0, true));
    case 'sfixed32':
      return BigInt(dv.getInt32(0, true));
    case 'float':
      return dv.getFloat32(0, true);
    case 'fixed64':
      return dv.getBigUint64(0, true);
    case 'sfixed64':
      return dv.getBigInt64(0, true);
    case 'double':
      return dv.getFloat64(0, true);
  }
  throw new Error(`not a fixed type: ${type}`);
}

export function toHex(bytes: ArrayLike<number>, sep = ' '): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(sep);
}

export function hexByte(b: number): string {
  return b.toString(16).padStart(2, '0').toUpperCase();
}

export function parseHex(text: string): Uint8Array | string {
  const clean = text.replace(/0x/gi, '').replace(/[\s,:]/g, '');
  if (clean.length % 2 !== 0) return 'Odd number of hex digits';
  if (/[^0-9a-f]/i.test(clean)) return 'Only hex digits (0-9, A-F) are allowed';
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function base64Encode(bytes: ArrayLike<number>): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

export function base64Decode(text: string): Uint8Array | null {
  try {
    const norm = text.replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
    const s = atob(norm);
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** Human-friendly float formatting that keeps -0 / NaN / Infinity visible. */
export function formatFloat(n: number): string {
  if (Object.is(n, -0)) return '-0';
  if (Number.isNaN(n)) return 'NaN';
  if (!Number.isFinite(n)) return n > 0 ? 'Infinity' : '-Infinity';
  const s = String(n);
  return /[.eE]/.test(s) ? s : s + '.0';
}
