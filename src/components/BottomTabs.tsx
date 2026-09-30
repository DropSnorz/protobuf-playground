import { useMemo, useState } from 'react';
import type { DiffEntry } from '../proto/diff';
import type { Step } from '../proto/steps';
import type { ByteInfo, Range } from '../proto/trace';
import { WIRE_TYPE_NAMES } from '../proto/types';
import { toHex } from '../proto/wire';
import { fieldColorClass } from './colors';
import { useHighlight } from './highlight';
import { Rich } from './Rich';

type Tab = 'bytes' | 'diff' | 'json' | 'timeline';

function meaning(info: ByteInfo | null): { text: string; color: string } {
  if (!info) return { text: '—', color: 'fc-none' };
  const n = info.node;
  const color = fieldColorClass(info.root.fieldNumber, info.node.kind === 'unknown' || info.root.kind === 'unknown' ? 'unknown' : info.node.kind === 'error' ? 'error' : undefined);
  if (n.kind === 'error') return { text: n.display, color };
  const name = n.kind === 'unknown' ? `unknown #${n.fieldNumber}` : n.path || n.label;
  if (info.role === 'tag') return { text: `\`${name}\` tag → field #${n.fieldNumber}, ${WIRE_TYPE_NAMES[n.wireType!]}`, color };
  if (info.role === 'len') return { text: `\`${name}\` length = ${n.len?.value}`, color };
  return { text: `\`${name}\` = ${n.display}`, color };
}

function ByteTable({ bytes, pAnn, cAnn }: { bytes: Uint8Array; pAnn: (ByteInfo | null)[] | null; cAnn: (ByteInfo | null)[] }) {
  const { setHover } = useHighlight();
  const rows = useMemo(() => {
    const out: { start: number; end: number; p: ByteInfo | null; c: ByteInfo | null }[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const p = pAnn?.[i] ?? null;
      const c = cAnn[i] ?? null;
      const last = out[out.length - 1];
      const same = (a: ByteInfo | null, b: ByteInfo | null) => a?.node === b?.node && a?.role === b?.role;
      if (last && same(last.p, p) && same(last.c, c)) last.end = i + 1;
      else out.push({ start: i, end: i + 1, p, c });
    }
    return out;
  }, [bytes, pAnn, cAnn]);
  if (!bytes.length) return <div className="empty">No bytes on the wire.</div>;
  return (
    <table className="byte-table">
      <thead>
        <tr>
          <th>Offset</th>
          <th>Bytes</th>
          <th>Producer meant</th>
          <th>Consumer understood</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const pm = pAnn ? meaning(r.p) : { text: '(hand-crafted)', color: 'fc-none' };
          const cm = meaning(r.c);
          const differs = pAnn && r.p && r.c && (r.p.node.fieldNumber !== r.c.node.fieldNumber || r.c.node.status !== 'ok');
          const range: Range = { start: r.start, end: r.end };
          return (
            <tr key={r.start} onMouseEnter={() => setHover({ ranges: [range] })} onMouseLeave={() => setHover(null)} className={differs ? 'row-differs' : ''}>
              <td className="mono muted">{r.start}</td>
              <td className="mono">
                <span className={`chip-inline ${pm.color !== 'fc-none' ? pm.color : cm.color} role-${r.c?.role ?? r.p?.role ?? 'value'}`}>{toHex(bytes.subarray(r.start, r.end))}</span>
              </td>
              <td>
                <Rich text={pm.text} />
              </td>
              <td className={r.c?.node.status === 'warn' ? 'cell-warn' : r.c?.node.kind === 'unknown' ? 'cell-unknown' : r.c?.node.kind === 'error' ? 'cell-error' : ''}>
                <Rich text={cm.text} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

const SEV: Record<DiffEntry['severity'], string> = { compatible: '✓ compatible', caution: '! caution', breaking: '✕ breaking' };

function SchemaDiff({ entries, linked }: { entries: DiffEntry[]; linked: boolean }) {
  if (linked) return <div className="empty">Both sides use the same schema. Click <strong>edit separately</strong> on the consumer to simulate a different version.</div>;
  if (!entries.length) return <div className="empty">No wire-relevant difference between the two message definitions.</div>;
  const order = { breaking: 0, caution: 1, compatible: 2 };
  return (
    <ul className="diff-list">
      {[...entries]
        .sort((a, b) => order[a.severity] - order[b.severity])
        .map((e, i) => (
          <li key={i} className={`diff diff-${e.severity}`}>
            <span className={`diff-sev sev-${e.severity}`}>{SEV[e.severity]}</span>
            <div>
              <div className="diff-title">
                <Rich text={e.title} /> <span className="muted small">in {e.where}</span>
              </div>
              <div className="diff-detail">
                <Rich text={e.detail} />
              </div>
            </div>
          </li>
        ))}
    </ul>
  );
}

export function BottomTabs(props: {
  bytes: Uint8Array;
  pAnn: (ByteInfo | null)[] | null;
  cAnn: (ByteInfo | null)[];
  diff: DiffEntry[];
  linked: boolean;
  json: (includeDefaults: boolean) => string;
  steps: Step[];
  index: number;
  onIndex: (i: number) => void;
}) {
  const [tab, setTab] = useState<Tab>('bytes');
  const [defaults, setDefaults] = useState(false);
  const breaking = props.diff.filter((d) => d.severity === 'breaking').length;
  const caution = props.diff.filter((d) => d.severity === 'caution').length;
  return (
    <section className="panel bottom">
      <div className="tabs" role="tablist">
        <button role="tab" className={`tab ${tab === 'bytes' ? 'tab-on' : ''}`} onClick={() => setTab('bytes')}>
          Byte-by-byte
        </button>
        <button role="tab" className={`tab ${tab === 'diff' ? 'tab-on' : ''}`} onClick={() => setTab('diff')}>
          Schema diff
          {!props.linked && breaking > 0 && <span className="count count-breaking">{breaking}</span>}
          {!props.linked && caution > 0 && <span className="count count-caution">{caution}</span>}
        </button>
        <button role="tab" className={`tab ${tab === 'json' ? 'tab-on' : ''}`} onClick={() => setTab('json')}>
          Decoded JSON
        </button>
        <button role="tab" className={`tab ${tab === 'timeline' ? 'tab-on' : ''}`} onClick={() => setTab('timeline')}>
          All steps <span className="muted">{props.steps.length}</span>
        </button>
      </div>
      <div className="bottom-body">
        {tab === 'bytes' && <ByteTable bytes={props.bytes} pAnn={props.pAnn} cAnn={props.cAnn} />}
        {tab === 'diff' && <SchemaDiff entries={props.diff} linked={props.linked} />}
        {tab === 'json' && (
          <div>
            <label className="check">
              <input type="checkbox" checked={defaults} onChange={(e) => setDefaults(e.target.checked)} /> include default values (like
              <code>alwaysPrintFieldsWithNoPresence</code>)
            </label>
            <pre className="json-out">{props.json(defaults)}</pre>
            <p className="muted small">Proto3 JSON mapping: 64-bit integers as strings, bytes as base64, enums by name (unknown enum numbers stay numeric). Unknown fields are not representable in JSON and are dropped.</p>
          </div>
        )}
        {tab === 'timeline' && (
          <ol className="timeline">
            {props.steps.map((s, i) => (
              <li key={i} className={`tl tl-${s.status} ${i === props.index ? 'tl-on' : ''} tl-phase-${s.phase}`} onClick={() => props.onIndex(i)}>
                <span className="tl-phase">{s.phase}</span>
                <span className="tl-title">
                  <Rich text={s.title} />
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
