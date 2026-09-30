import { Pencil, Undo2 } from 'lucide-react';
import { useState } from 'react';
import type { Step } from '../proto/steps';
import type { ByteInfo, Range } from '../proto/trace';
import { WIRE_TYPE_NAMES } from '../proto/types';
import { hexByte, parseHex, toHex } from '../proto/wire';
import { ByteBuffer } from './ByteBuffer';
import { CalcView } from './CalcView';
import { PhaseBar, Player } from './Player';
import { Rich } from './Rich';

interface Props {
  steps: Step[];
  index: number;
  playing: boolean;
  speed: number;
  onIndex: (i: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (s: number) => void;
  bytes: Uint8Array;
  producerAnn: (ByteInfo | null)[] | null;
  consumerAnn: (ByteInfo | null)[];
  hoverRanges: Range[];
  onHoverByte: (offset: number | null) => void;
  hoverByte: number | null;
  override: string | null;
  onOverride: (hex: string | null) => void;
  errorRange?: Range;
}

function describe(info: ByteInfo | null): string {
  if (!info) return '-';
  const n = info.node;
  if (n.kind === 'error') return 'parse error';
  const name = n.kind === 'unknown' ? `unknown #${n.fieldNumber}` : n.path || n.label;
  if (info.role === 'tag') return `${name} · tag (#${n.fieldNumber}, ${WIRE_TYPE_NAMES[n.wireType!]})`;
  if (info.role === 'len') return `${name} · length = ${n.len?.value}`;
  return `${name} · value ${n.display}`;
}

export function WirePanel(p: Props) {
  const step = p.steps[Math.min(p.index, p.steps.length - 1)];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const parsed = editing ? parseHex(draft) : null;
  const total = p.bytes.length;
  const transmitting = step.phase === 'transmit';
  const received = step.consumed >= 0;

  return (
    <section className="panel wire-panel" aria-label="Wire">
      <header className="panel-head">
        <div className="panel-title">
          <span className="role-dot role-wire" />
          <h2>Wire</h2>
          <span className="chip-count">{total} bytes</span>
          {p.override !== null && <span className="badge badge-warn">hand-crafted</span>}
        </div>
        <div className="panel-actions">
          {!editing && (
            <button
              className="btn btn-ghost"
              onClick={() => {
                setDraft(p.override ?? toHex(p.bytes));
                setEditing(true);
              }}
              title="Type your own bytes to simulate buggy producers, truncation, concatenation…"
            >
              <Pencil size={14} /> Edit bytes
            </button>
          )}
          {p.override !== null && !editing && (
            <button className="btn btn-ghost" onClick={() => p.onOverride(null)} title="Go back to the producer's encoded output">
              <Undo2 size={14} /> Use producer output
            </button>
          )}
        </div>
      </header>

      <PhaseBar phase={step.phase} status={step.status} />
      <Player
        index={p.index}
        count={p.steps.length}
        playing={p.playing}
        speed={p.speed}
        onIndex={p.onIndex}
        onPlay={p.onPlay}
        onPause={p.onPause}
        onSpeed={p.onSpeed}
      />

      <div className={`step-card step-${step.status}`} key={p.index}>
        <div className="step-title">
          <Rich text={step.title} />
        </div>
        {step.detail.filter(Boolean).map((d, i) => (
          <p key={i} className="step-detail">
            <Rich text={d} />
          </p>
        ))}
        <CalcView calc={step.calc} />
      </div>

      {editing ? (
        <div className="hex-editor">
          <label className="buffer-label" htmlFor="hex-input">
            Bytes in hex (spaces optional)
          </label>
          <textarea id="hex-input" value={draft} onChange={(e) => setDraft(e.target.value)} spellCheck={false} rows={4} />
          {typeof parsed === 'string' && <div className="error-text">{parsed}</div>}
          <div className="hex-editor-actions">
            <button className="btn btn-ghost" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              disabled={typeof parsed === 'string'}
              onClick={() => {
                p.onOverride(toHex(parsed as Uint8Array));
                setEditing(false);
              }}
            >
              Send these bytes
            </button>
          </div>
        </div>
      ) : (
        <div className="stage">
          <div className="buffer-label">
            <span>Producer output buffer</span>
            <span className="muted">{Math.min(step.emitted, total)} / {total} B written</span>
          </div>
          <ByteBuffer
            bytes={p.bytes}
            ann={p.producerAnn}
            visible={step.emitted}
            fresh={step.phase === 'encode' ? step.range : undefined}
            current={step.phase === 'encode' ? step.range : undefined}
            hoverRanges={p.hoverRanges}
            onHover={p.onHoverByte}
            animKey={`p${p.index}`}
            emptyText={step.phase === 'encode' && step.emitted === 0 && total > 0 ? 'Nothing written yet…' : 'Empty buffer (0 bytes)'}
          />

          <div className={`pipe ${transmitting ? 'pipe-active' : ''} ${received ? 'pipe-done' : ''}`} aria-hidden>
            <span className="pipe-end">producer</span>
            <div className="pipe-tube">
              {transmitting &&
                Array.from(p.bytes.slice(0, 14)).map((b, i) => (
                  <span key={`${p.index}-${i}`} className="packet" style={{ animationDelay: `${i * 90}ms` }}>
                    {hexByte(b)}
                  </span>
                ))}
              {!transmitting && <span className="pipe-label">{received ? `${total} bytes delivered` : 'waiting…'}</span>}
            </div>
            <span className="pipe-end">consumer</span>
          </div>

          <div className="buffer-label">
            <span>Consumer input buffer</span>
            <span className="muted">
              {received ? `${Math.max(0, Math.min(step.consumed, total))} / ${total} B read` : 'nothing received yet'}
            </span>
          </div>
          <ByteBuffer
            bytes={p.bytes}
            ann={step.phase === 'decode' || step.phase === 'done' ? p.consumerAnn : null}
            visible={received ? total : 0}
            consumed={step.phase === 'decode' || step.phase === 'done' ? step.consumed : -1}
            current={step.phase === 'decode' ? step.range : undefined}
            hoverRanges={p.hoverRanges}
            onHover={p.onHoverByte}
            arriving={transmitting}
            animKey={transmitting ? `t${p.index}` : 'c'}
            errorRange={step.phase === 'done' || (step.phase === 'decode' && step.status === 'error') ? p.errorRange : undefined}
            emptyText="Empty message (0 bytes)"
          />

          <div className="inspector">
            {p.hoverByte !== null && p.hoverByte < total ? (
              <>
                <span className="inspector-byte">
                  byte {p.hoverByte} · <strong>0x{hexByte(p.bytes[p.hoverByte])}</strong> ·{' '}
                  <code>{p.bytes[p.hoverByte].toString(2).padStart(8, '0')}</code>
                </span>
                <span>
                  <span className="side-tag side-producer">P</span> {p.producerAnn ? describe(p.producerAnn[p.hoverByte]) : 'hand-crafted'}
                </span>
                <span>
                  <span className="side-tag side-consumer">C</span> {describe(p.consumerAnn[p.hoverByte])}
                </span>
              </>
            ) : (
              <span className="muted">Hover a byte to see how each side interprets it.</span>
            )}
          </div>

          <div className="legend">
            <span className="chip role-tag fc-0">08</span> tag
            <span className="chip role-len fc-0">05</span> length
            <span className="chip role-value fc-0">41</span> value
            <span className="chip role-value fc-unknown">7F</span> unknown field
            <span className="chip chip-error role-value fc-error">C3</span> error
            <span className="muted">· same color = same field number</span>
          </div>
        </div>
      )}
    </section>
  );
}
