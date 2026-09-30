import { TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import type { DecodedField, DecodedMessage, DValue } from '../proto/decoder';
import type { TraceNode } from '../proto/trace';
import { WIRE_TYPE_NAMES } from '../proto/types';
import { fieldColorClass } from './colors';
import { pathRelation, useHighlight } from './highlight';

interface Props {
  message: DecodedMessage | null;
  nodesByPath: Map<string, TraceNode[]>;
  follow: boolean;
  /** Paths already decoded at the current step (others are pending). */
  revealed: ((path: string) => boolean) | null;
}

const p = (base: string, name: string) => (base ? `${base}.${name}` : name);

export function DecodeTree({ message, nodesByPath, follow, revealed }: Props) {
  const { active, hover, setHover, consumerRanges } = useHighlight();
  const focus = hover?.consumerPath ?? active.consumerPath;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!follow || !active.consumerPath || !ref.current) return;
    const el = ref.current.querySelector<HTMLElement>(`[data-path="${CSS.escape(active.consumerPath)}"]`);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [active.consumerPath, follow]);

  if (!message) return <div className="tree empty">Nothing decoded.</div>;

  const notesFor = (path: string) => {
    const ns = nodesByPath.get(path) ?? [];
    const notes = ns.flatMap((n) => n.notes);
    const warn = ns.some((n) => n.status === 'warn');
    return { notes, warn };
  };

  const rowEl = (opts: {
    path: string;
    depth: number;
    num?: number | string;
    rootNum?: number;
    name: ReactNode;
    type?: string;
    value: ReactNode;
    badge?: ReactNode;
    cls?: string;
    title?: string;
  }) => {
    const rel = pathRelation(opts.path, focus);
    const pending = revealed && !revealed(opts.path);
    return (
      <div
        key={opts.path + String(opts.num)}
        data-path={opts.path}
        className={`trow ${opts.cls ?? ''} ${rel ? `trow-${rel}` : ''} ${pending ? 'trow-pending' : ''}`}
        style={{ paddingLeft: 8 + opts.depth * 16 }}
        onMouseEnter={() => setHover({ consumerPath: opts.path, ranges: consumerRanges(opts.path) })}
        onMouseLeave={() => setHover(null)}
        title={opts.title}
      >
        <span className={`tnum ${opts.num === undefined ? '' : fieldColorClass(opts.rootNum, opts.cls === 'trow-unknown' ? 'unknown' : undefined)} ${opts.depth > 0 ? 'tnum-nested' : ''}`}>
          {opts.num ?? ''}
        </span>
        <span className="tname">{opts.name}</span>
        <span className="ttype">{opts.type}</span>
        <span className="tval">{pending ? <span className="muted">…</span> : opts.value}</span>
        <span className="tmeta">{pending ? null : opts.badge}</span>
      </div>
    );
  };

  const renderValue = (v: DValue, path: string, depth: number, rootNum: number, label: string, f: DecodedField['def']): ReactNode[] => {
    const { notes, warn } = notesFor(path);
    const badge = warn ? <span className="badge badge-warn" title="Warning"><TriangleAlert size={12} /></span> : null;
    switch (v.k) {
      case 'scalar':
        return [
          rowEl({ path, depth, name: label, type: undefined, value: v.display, badge, cls: warn ? 'trow-warn' : '', title: notes.join('\n'), rootNum }),
        ];
      case 'message':
        return [
          rowEl({ path, depth, name: label, type: v.msg.type.name, value: <span className="muted">{'{…}'}</span>, badge, cls: warn ? 'trow-warn' : '', title: notes.join('\n'), rootNum }),
          ...renderMessage(v.msg, path, depth + 1, rootNum),
        ];
      case 'list':
        return v.items.flatMap((it, i) => renderValue(it, `${path}[${i}]`, depth, rootNum, `[${i}]`, f));
      case 'map':
        return v.entries.flatMap((e) => {
          const key = typeof e.key === 'string' ? e.key : String(e.key);
          const ep = `${path}[${JSON.stringify(key)}]`;
          if (e.value.k === 'message') {
            const n = notesFor(ep);
            return [
              rowEl({ path: ep, depth, name: `[${e.keyDisplay}]`, value: <span className="muted">{'{…}'}</span>, rootNum, badge: n.warn ? <span className="badge badge-warn" title="Warning"><TriangleAlert size={12} /></span> : null, title: n.notes.join('\n') }),
              ...renderMessage(e.value.msg, `${ep}.value`, depth + 1, rootNum),
            ];
          }
          const n = notesFor(ep);
          return [
            rowEl({
              path: ep,
              depth,
              name: `[${e.keyDisplay}]`,
              value: e.value.k === 'scalar' ? e.value.display : '',
              rootNum,
              badge: n.warn ? <span className="badge badge-warn" title="Warning"><TriangleAlert size={12} /></span> : null,
              cls: n.warn ? 'trow-warn' : '',
              title: n.notes.join('\n'),
            }),
          ];
        });
    }
  };

  const renderField = (f: DecodedField, base: string, depth: number, rootNum?: number): ReactNode[] => {
    const path = p(base, f.def.name);
    const rn = rootNum ?? f.def.number;
    if (f.state !== 'present') {
      return [
        rowEl({
          path,
          depth,
          num: f.def.number,
          rootNum: rn,
          name: f.def.name,
          type: f.def.displayType,
          value: <span className="muted">{f.display}</span>,
          badge: <span className={`badge ${f.state === 'unset' ? 'badge-muted' : 'badge-default'}`}>{f.state === 'unset' ? 'not set' : 'default'}</span>,
          cls: 'trow-absent',
          title:
            f.state === 'unset'
              ? 'Absent from the wire. The field has presence: has_' + f.def.name + '() returns false.'
              : 'Absent from the wire: the consumer sees the default value.',
        }),
      ];
    }
    const { notes, warn } = notesFor(path);
    const v = f.value!;
    const head = rowEl({
      path,
      depth,
      num: f.def.number,
      rootNum: rn,
      name: f.def.name,
      type: f.def.displayType,
      value: v.k === 'scalar' ? v.display : v.k === 'message' ? <span className="muted">{'{…}'}</span> : <span className="muted">{f.display}</span>,
      badge: warn || f.status === 'warn' ? <span className="badge badge-warn" title="Warning"><TriangleAlert size={12} /></span> : null,
      cls: warn || f.status === 'warn' ? 'trow-warn' : '',
      title: notes.join('\n'),
    });
    if (v.k === 'scalar') return [head];
    if (v.k === 'message') return [head, ...renderMessage(v.msg, path, depth + 1, rn)];
    return [head, ...renderValue(v, path, depth + 1, rn, '', f.def)];
  };

  const renderMessage = (msg: DecodedMessage, base: string, depth: number, rootNum?: number): ReactNode[] => [
    ...msg.fields.flatMap((f) => renderField(f, base, depth, rootNum)),
    ...msg.unknown.map((n) =>
      rowEl({
        path: n.path,
        depth,
        num: n.fieldNumber,
        rootNum: n.fieldNumber,
        name: n.field ? <s>{n.field.name}</s> : <em>unknown</em>,
        type: WIRE_TYPE_NAMES[n.wireType!],
        value: n.display,
        badge: <span className={`badge ${n.status === 'warn' ? 'badge-warn' : 'badge-unknown'}`}>{n.status === 'warn' ? 'mismatch' : 'unknown'}</span>,
        cls: 'trow-unknown',
        title: n.notes.join('\n'),
      }),
    ),
  ];

  return (
    <div className="tree" ref={ref}>
      <div className="tree-root">
        <span className="tree-root-name">{message.type.name}</span>
        <span className="muted">
          {message.fields.filter((f) => f.state === 'present').length} read · {message.fields.filter((f) => f.state !== 'present').length} absent
          {message.unknown.length ? ` · ${message.unknown.length} unknown` : ''}
        </span>
      </div>
      {renderMessage(message, '', 0)}
    </div>
  );
}
