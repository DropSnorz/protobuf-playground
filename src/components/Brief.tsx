import { Check, ChevronDown, ChevronUp, Eye, Link2, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import type { Scenario } from '../scenarios';
import { Rich } from './Rich';
import { VERDICT_META, VerdictIcon } from './Sidebar';

export function Brief({ scenario, modified, onReset, onShare, shared }: {
  scenario: Scenario | undefined;
  modified: boolean;
  onReset: () => void;
  onShare: () => void;
  shared: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="brief">
      <div className="brief-head">
        <div className="brief-title">
          {scenario ? (
            <>
              <span className={`verdict ${VERDICT_META[scenario.verdict].cls}`}>
                <VerdictIcon verdict={scenario.verdict} />
                {VERDICT_META[scenario.verdict].label}
              </span>
              <span className="brief-cat">{scenario.category}</span>
              <h1>{scenario.title}</h1>
              {modified && <span className="badge badge-muted">modified</span>}
            </>
          ) : (
            <h1>Custom experiment</h1>
          )}
        </div>
        <div className="brief-actions">
          {scenario && modified && (
            <button className="btn btn-ghost" onClick={onReset} title="Restore the scenario's original schemas and message">
              <RotateCcw size={14} /> Reset scenario
            </button>
          )}
          <button className="btn btn-ghost" onClick={onShare} title="Copy a link containing the current schemas and message">
            {shared ? (
              <>
                <Check size={14} /> Link copied
              </>
            ) : (
              <>
                <Link2 size={14} /> Share
              </>
            )}
          </button>
          {scenario && (
            <button className="btn btn-ghost" onClick={() => setOpen(!open)} aria-expanded={open}>
              {open ? 'Hide notes' : 'Show notes'} {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>
          )}
        </div>
      </div>
      {scenario && open && (
        <div className="brief-body">
          <div className="brief-desc">
            {scenario.description.map((d, i) => (
              <p key={i}>
                <Rich text={d} />
              </p>
            ))}
          </div>
          <div className="brief-observe">
            <div className="observe-title">
              <Eye size={15} /> What to watch
            </div>
            <ul>
              {scenario.observe.map((o, i) => (
                <li key={i}>
                  <Rich text={o} />
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
