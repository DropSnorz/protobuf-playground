import { useEffect, useMemo, useRef } from 'react';
import type { TraceNode } from '../proto/trace';
import { WIRE_TYPE_NAMES } from '../proto/types';
import { fieldColorClass } from './colors';
import { useHighlight } from './highlight';

function ancestorsOf(nodes: TraceNode[], id: string | undefined): Set<string> {
  const out = new Set<string>();
  if (!id) return out;
  const visit = (ns: TraceNode[], chain: string[]): boolean => {
    for (const n of ns) {
      if (n.id === id) {
        chain.forEach((c) => out.add(c));
        return true;
      }
      if (n.children && visit(n.children, [...chain, n.id])) return true;
    }
    return false;
  };
  visit(nodes, []);
  return out;
}

export function EncodeTree({ nodes, typeName, follow }: { nodes: TraceNode[]; typeName: string; follow: boolean }) {
  const { active, hover, setHover, producerRange } = useHighlight();
  const focusId = hover?.producerId ?? active.producerId;
  const ancestors = useMemo(() => ancestorsOf(nodes, focusId), [nodes, focusId]);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!follow || !active.producerId || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-id="${active.producerId}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active.producerId, follow]);

  const row = (n: TraceNode, depth: number, rootNumber?: number) => {
    const color = fieldColorClass(rootNumber ?? n.fieldNumber, n.kind);
    const state = n.id === focusId ? 'self' : ancestors.has(n.id) ? 'ancestor' : '';
    const size = n.end - n.start;
    return (
      <div key={n.id}>
        <div
          data-id={n.id}
          className={`trow ${n.kind === 'skipped' ? 'trow-skipped' : ''} ${state ? `trow-${state}` : ''}`}
          style={{ paddingLeft: 8 + depth * 16 }}
          onMouseEnter={() => setHover({ producerId: n.id, ranges: producerRange(n.id) })}
          onMouseLeave={() => setHover(null)}
          title={n.notes.join('\n')}
        >
          <span className={`tnum ${color} ${depth > 0 ? 'tnum-nested' : ''}`}>{n.fieldNumber !== undefined && n.kind !== 'element' ? n.fieldNumber : ''}</span>
          <span className="tname">{n.label}</span>
          <span className="ttype">{n.typeName}</span>
          <span className="tval">{n.display}</span>
          <span className="tmeta">
            {n.kind === 'skipped' ? (
              <span className="badge badge-muted">not sent</span>
            ) : (
              <>
                {n.wireType !== undefined && n.kind === 'field' && <span className="wt">{WIRE_TYPE_NAMES[n.wireType]}</span>}
                <span className="bytes-count">{size} B</span>
              </>
            )}
          </span>
        </div>
        {n.children?.map((c) => row(c, depth + 1, rootNumber ?? n.fieldNumber))}
      </div>
    );
  };

  return (
    <div className="tree" ref={ref}>
      <div className="tree-root">
        <span className="tree-root-name">{typeName.split('.').pop()}</span>
        <span className="muted">
          {nodes.filter((n) => n.kind !== 'skipped').length} of {nodes.length} fields written
        </span>
      </div>
      {nodes.length === 0 && <div className="empty">This message has no fields.</div>}
      {nodes.map((n) => row(n, 0))}
    </div>
  );
}
