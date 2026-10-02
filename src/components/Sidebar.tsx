import { Check, Info, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CATEGORIES, SCENARIOS, type Verdict } from '../scenarios';

export const VERDICT_META: Record<Verdict, { Icon: LucideIcon; label: string; cls: string }> = {
  learn: { Icon: Info, label: 'How it works', cls: 'v-learn' },
  compatible: { Icon: Check, label: 'Compatible', cls: 'v-compatible' },
  caution: { Icon: TriangleAlert, label: 'Lossy / surprising', cls: 'v-caution' },
  breaking: { Icon: X, label: 'Breaking / failure', cls: 'v-breaking' },
};

export function VerdictIcon({ verdict }: { verdict: Verdict }) {
  const { Icon, cls } = VERDICT_META[verdict];
  return (
    <span className={`v-icon ${cls}`} aria-hidden>
      <Icon size={11} strokeWidth={3} />
    </span>
  );
}

export function Sidebar({ current, onSelect, modified }: { current: string | null; onSelect: (id: string) => void; modified: boolean }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Verdict | null>(null);
  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return CATEGORIES.map((c) => ({
      category: c,
      items: SCENARIOS.filter(
        (s) =>
          s.category === c &&
          (!filter || s.verdict === filter) &&
          (!needle || `${s.title} ${s.summary} ${s.category}`.toLowerCase().includes(needle)),
      ),
    })).filter((g) => g.items.length);
  }, [q, filter]);

  return (
    <nav className="sidebar" aria-label="Scenarios">
      <div className="brand">
        <span className="brand-logo">pb</span>
        <div>
          <div className="brand-name">Protobuf Playground</div>
          <div className="brand-sub">Encode, send, decode, step by step</div>
        </div>
      </div>
      <input className="search" placeholder="Search scenarios…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search scenarios" />
      <div className="verdict-filter">
        {(Object.keys(VERDICT_META) as Verdict[]).map((v) => (
          <button
            key={v}
            className={`vf ${VERDICT_META[v].cls} ${filter === v ? 'vf-on' : ''}`}
            onClick={() => setFilter(filter === v ? null : v)}
            title={`Show only: ${VERDICT_META[v].label}`}
          >
            <VerdictIcon verdict={v} />
            {VERDICT_META[v].label}
          </button>
        ))}
      </div>
      <div className="scenario-list">
        {groups.map((g) => (
          <div key={g.category} className="sgroup">
            <div className="sgroup-title">{g.category}</div>
            {g.items.map((s) => (
              <button
                key={s.id}
                className={`sitem ${current === s.id ? 'sitem-on' : ''}`}
                onClick={() => onSelect(s.id)}
                title={s.summary}
              >
                <VerdictIcon verdict={s.verdict} />
                <span className="sitem-text">
                  <span className="sitem-title">{s.title}</span>
                  <span className="sitem-sum">{s.summary}</span>
                </span>
                {current === s.id && modified && <span className="modified-dot" title="Modified" />}
              </button>
            ))}
          </div>
        ))}
        {!groups.length && <div className="empty">No scenario matches.</div>}
      </div>
      <div className="sidebar-foot">
        Everything runs in your browser. Nothing is uploaded.
      </div>
    </nav>
  );
}
