import { ArrowLeftRight } from 'lucide-react';
import type { Calc } from '../proto/trace';
import { WIRE_TYPE_NAMES } from '../proto/types';
import { hexByte } from '../proto/wire';

const bin = (n: number | bigint, width = 0) => n.toString(2).padStart(width, '0');

function ByteList({ bytes, max = 24 }: { bytes: number[]; max?: number }) {
  const shown = bytes.slice(0, max);
  return (
    <span className="calc-bytes">
      {shown.map((b, i) => (
        <span key={i} className="calc-byte">
          {hexByte(b)}
        </span>
      ))}
      {bytes.length > max && <span className="muted"> … +{bytes.length - max}</span>}
    </span>
  );
}

function VarintView({ value, bytes }: { value: bigint; bytes: number[] }) {
  const groups = bytes.map((b) => b & 0x7f);
  const long = bytes.length > 5;
  return (
    <div className="calc-block">
      <div className="calc-caption">
        Varint of <strong>{value.toString()}</strong>: 7 bits per byte, least significant group first
      </div>
      <div className={`varint-row ${long ? 'varint-long' : ''}`}>
        {bytes.map((b, i) => (
          <div key={i} className="varint-byte" title={`byte ${i}: 0x${hexByte(b)}`}>
            <div className="varint-bits">
              <span className={`msb ${b & 0x80 ? 'msb-on' : ''}`} title={b & 0x80 ? 'MSB = 1: more bytes follow' : 'MSB = 0: last byte'}>
                {b >> 7}
              </span>
              <span className="payload-bits">{bin(b & 0x7f, 7)}</span>
            </div>
            <div className="varint-hex">{hexByte(b)}</div>
          </div>
        ))}
      </div>
      {bytes.length > 1 && (
        <div className="calc-line">
          <span className="muted">reassemble (reverse the groups):</span>{' '}
          <code className="wrap">
            {groups
              .slice()
              .reverse()
              .map((g) => bin(g, 7))
              .join(' ')}
          </code>{' '}
          = <strong>{value.toString()}</strong>
        </div>
      )}
    </div>
  );
}

export function CalcItem({ c }: { c: Calc }) {
  switch (c.kind) {
    case 'tag': {
      const fnBits = bin(c.fieldNumber);
      return (
        <div className="calc-block">
          <div className="calc-caption">Tag = (field_number &lt;&lt; 3) | wire_type</div>
          <div className="tag-formula">
            <span className="tf-part tf-field">
              <span className="tf-label">field #</span>
              <span className="tf-val">{c.fieldNumber}</span>
              <code>{fnBits}</code>
            </span>
            <span className="tf-op">&lt;&lt; 3 |</span>
            <span className="tf-part tf-wt">
              <span className="tf-label">wire type</span>
              <span className="tf-val">
                {c.wireType} <small>{WIRE_TYPE_NAMES[c.wireType]}</small>
              </span>
              <code>{bin(c.wireType, 3)}</code>
            </span>
            <span className="tf-op">=</span>
            <span className="tf-part">
              <span className="tf-label">tag</span>
              <span className="tf-val">{c.value.toString()}</span>
              <code>
                <span className="tf-field-bits">{fnBits}</span>
                <span className="tf-wt-bits">{bin(c.wireType, 3)}</span>
              </code>
            </span>
          </div>
          {c.bytes.length > 1 ? (
            <VarintView value={c.value} bytes={c.bytes} />
          ) : (
            <div className="calc-line">
              Fits in one byte → <ByteList bytes={c.bytes} />
            </div>
          )}
        </div>
      );
    }
    case 'varint':
      return <VarintView value={c.value} bytes={c.bytes} />;
    case 'zigzag':
      return (
        <div className="calc-block">
          <div className="calc-caption">ZigZag ({c.bits}-bit): 0→0, -1→1, 1→2, -2→3, 2→4 …</div>
          {c.decode ? (
            <div className="calc-line">
              <code>(z &gt;&gt;&gt; 1) ^ -(z &amp; 1)</code> with z = <strong>{c.output.toString()}</strong> →{' '}
              <strong>{c.input.toString()}</strong>
            </div>
          ) : (
            <div className="calc-line">
              <code>
                (n &lt;&lt; 1) ^ (n &gt;&gt; {c.bits - 1})
              </code>{' '}
              with n = <strong>{c.input.toString()}</strong> → <strong>{c.output.toString()}</strong>
            </div>
          )}
        </div>
      );
    case 'twos':
      return (
        <div className="calc-block">
          <div className="calc-caption">Negative number → 64-bit two's complement</div>
          <div className="calc-line">
            <strong>{c.input.toString()}</strong> ≡ <code className="wrap">0x{c.output.toString(16).toUpperCase()}</code> (
            {c.output.toString()}) → a 10-byte varint
          </div>
        </div>
      );
    case 'fixed':
      return (
        <div className="calc-block">
          <div className="calc-caption">
            {c.type}: {c.bytes.length} bytes, little-endian{c.type === 'float' || c.type === 'double' ? ' (IEEE 754)' : ''}
          </div>
          <div className="calc-line">
            <strong>{c.display}</strong> → <ByteList bytes={c.bytes} />
            <span className="muted"> (least significant byte first)</span>
          </div>
        </div>
      );
    case 'utf8': {
      const chars = Array.from(c.text);
      const enc = new TextEncoder();
      return (
        <div className="calc-block">
          <div className="calc-caption">
            UTF-8: {chars.length} character{chars.length === 1 ? '' : 's'} → {c.bytes.length} byte{c.bytes.length === 1 ? '' : 's'}
          </div>
          <div className="utf8-row">
            {chars.slice(0, 40).map((ch, i) => (
              <span key={i} className={`utf8-char ${enc.encode(ch).length > 1 ? 'utf8-multi' : ''}`}>
                <span className="utf8-glyph">{ch === ' ' ? '␣' : ch}</span>
                <ByteList bytes={Array.from(enc.encode(ch))} />
              </span>
            ))}
            {chars.length > 40 && <span className="muted">…</span>}
          </div>
        </div>
      );
    }
    case 'bytes':
      return (
        <div className="calc-block">
          <div className="calc-caption">Raw bytes, copied as-is</div>
          <div className="calc-line">
            {c.bytes.length ? <ByteList bytes={c.bytes} max={32} /> : <span className="muted">(empty)</span>}
          </div>
        </div>
      );
    case 'len':
      return (
        <div className="calc-block">
          <div className="calc-caption">Length prefix (varint)</div>
          <div className="calc-line">
            <strong>{c.length}</strong> byte{c.length === 1 ? '' : 's'} → <ByteList bytes={c.bytes} />
          </div>
        </div>
      );
    case 'enum':
      return (
        <div className="calc-block">
          <div className="calc-caption">Enum {c.enumName}: sent as its number</div>
          <div className="calc-line">
            {c.name ? <code>{c.name}</code> : <span className="badge badge-warn">unknown name</span>} <ArrowLeftRight size={13} className="inline-icon" /> <strong>{c.number}</strong>
          </div>
        </div>
      );
    case 'bool':
      return (
        <div className="calc-block">
          <div className="calc-caption">bool is a varint 0 / 1</div>
          <div className="calc-line">
            {c.raw !== undefined ? (
              <>
                varint <strong>{c.raw.toString()}</strong> → <code>{String(c.value)}</code>
              </>
            ) : (
              <>
                <code>{String(c.value)}</code> → <strong>{c.value ? 1 : 0}</strong>
              </>
            )}
          </div>
        </div>
      );
    case 'truncate':
      return (
        <div className="calc-block calc-warn">
          <div className="calc-caption">Truncation to {c.bits} bits</div>
          <div className="calc-line">
            <strong>{c.from.toString()}</strong> → keep the low {c.bits} bits{c.signed ? ' (signed)' : ''} →{' '}
            <strong>{c.to.toString()}</strong>
          </div>
        </div>
      );
  }
}

export function CalcView({ calc }: { calc: Calc[] }) {
  if (!calc.length) return null;
  return (
    <div className="calc">
      {calc.map((c, i) => (
        <CalcItem key={i} c={c} />
      ))}
    </div>
  );
}
