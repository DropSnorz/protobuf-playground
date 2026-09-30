import type { ByteInfo, Range } from '../proto/trace';
import { hexByte } from '../proto/wire';
import { fieldColorClass } from './colors';

interface Props {
  bytes: Uint8Array;
  ann: (ByteInfo | null)[] | null;
  /** Number of bytes visible (producer: emitted so far; consumer: received). */
  visible: number;
  /** Bytes appearing at this step (pop animation). */
  fresh?: Range;
  /** Bytes already read by the consumer (cursor position). */
  consumed?: number;
  /** Range being processed at this step. */
  current?: Range;
  hoverRanges: Range[];
  onHover: (offset: number | null) => void;
  /** Stagger the arrival of every byte (transmit animation). */
  arriving?: boolean;
  animKey: string | number;
  errorRange?: Range;
  emptyText: string;
}

const inRanges = (i: number, rs: Range[]) => rs.some((r) => i >= r.start && i < r.end);

export function ByteBuffer(p: Props) {
  if (p.bytes.length === 0) {
    return <div className="buffer buffer-empty">{p.emptyText}</div>;
  }
  const cells = [];
  for (let i = 0; i < p.bytes.length; i++) {
    const isCurrent = !!p.current && i >= p.current.start && i < p.current.end;
    // Consumer: bytes not read yet are shown raw (uninterpreted).
    const unread = p.consumed !== undefined && p.consumed >= 0 && i >= p.consumed && !isCurrent;
    const info = unread ? null : (p.ann?.[i] ?? null);
    const hidden = i >= p.visible;
    const cls = [
      'chip',
      info ? fieldColorClass(info.root.fieldNumber, info.node.kind === 'unknown' || info.root.kind === 'unknown' ? 'unknown' : undefined) : 'fc-none',
      info ? `role-${info.role}` : 'role-raw',
      hidden ? 'chip-hidden' : '',
      p.fresh && i >= p.fresh.start && i < p.fresh.end ? 'chip-fresh' : '',
      isCurrent ? 'chip-current' : '',
      inRanges(i, p.hoverRanges) ? 'chip-hover' : '',
      p.errorRange && i >= p.errorRange.start && i < p.errorRange.end ? 'chip-error' : '',
      p.arriving ? 'chip-arrive' : '',
    ]
      .filter(Boolean)
      .join(' ');
    cells.push(
      <span
        key={`${p.animKey}-${i}`}
        className={cls}
        style={p.arriving ? { animationDelay: `${Math.min(i * 35, 1400)}ms` } : undefined}
        onMouseEnter={() => p.onHover(i)}
        onMouseLeave={() => p.onHover(null)}
      >
        {hexByte(p.bytes[i])}
      </span>,
    );
  }
  return <div className="buffer">{cells}</div>;
}
