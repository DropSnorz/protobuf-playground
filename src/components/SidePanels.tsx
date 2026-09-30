import { useState, type ReactNode } from 'react';
import type { DecodedMessage } from '../proto/decoder';
import type { EncodeIssue } from '../proto/encoder';
import type { TraceNode } from '../proto/trace';
import type { SchemaError } from '../proto/types';
import { CodeEditor } from './CodeEditor';
import { DecodeTree } from './DecodeTree';
import { EncodeTree } from './EncodeTree';
import { Rich } from './Rich';

function TypeSelect({ types, value, onChange, disabled }: { types: string[]; value: string; onChange: (t: string) => void; disabled?: boolean }) {
  return (
    <label className="type-select">
      <span className="muted">message</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || !types.length}>
        {types.map((t) => (
          <option key={t} value={t}>
            {t.replace(/^\./, '')}
          </option>
        ))}
      </select>
    </label>
  );
}

function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'tab-on' : ''}`} onClick={() => onChange(t.id)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Problems({ schemaError, warnings, extra }: { schemaError?: SchemaError | null; warnings?: string[]; extra?: ReactNode }) {
  if (!schemaError && !warnings?.length && !extra) return null;
  return (
    <div className="problems">
      {schemaError && (
        <div className="problem problem-error">
          <strong>.proto error{schemaError.line ? ` (line ${schemaError.line})` : ''}:</strong> {schemaError.message}
        </div>
      )}
      {warnings?.map((w, i) => (
        <div key={i} className="problem problem-warn">
          <Rich text={w} />
        </div>
      ))}
      {extra}
    </div>
  );
}

export function ProducerPanel(props: {
  label?: string;
  proto: string;
  onProto: (v: string) => void;
  valueText: string;
  onValue: (v: string) => void;
  types: string[];
  typeName: string;
  onType: (t: string) => void;
  schemaError: SchemaError | null;
  warnings: string[];
  jsonError: { message: string; line?: number } | null;
  encodeErrors: EncodeIssue[];
  nodes: TraceNode[];
  follow: boolean;
  overridden: boolean;
}) {
  const [tab, setTab] = useState<'schema' | 'message'>('message');
  const valueProblems = props.jsonError || props.encodeErrors.length;
  return (
    <section className="panel side-panel" aria-label="Producer">
      <header className="panel-head">
        <div className="panel-title">
          <span className="role-dot role-producer" />
          <h2>Producer</h2>
          {props.label && <span className="version">{props.label}</span>}
          <span className="muted small">writes</span>
        </div>
        <TypeSelect types={props.types} value={props.typeName} onChange={props.onType} />
      </header>
      <Tabs
        tabs={[
          { id: 'message', label: <>Message <span className="muted">JSON</span>{valueProblems ? <span className="tab-dot tab-dot-error" /> : null}</> },
          { id: 'schema', label: <>Schema <span className="muted">.proto</span>{props.schemaError ? <span className="tab-dot tab-dot-error" /> : null}</> },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="editor-wrap">
        {tab === 'schema' ? (
          <CodeEditor language="proto" value={props.proto} onChange={props.onProto} errorLine={props.schemaError?.line} ariaLabel="Producer schema" />
        ) : (
          <CodeEditor language="json" value={props.valueText} onChange={props.onValue} errorLine={props.jsonError?.line} ariaLabel="Producer message JSON" />
        )}
      </div>
      <Problems
        schemaError={props.schemaError}
        warnings={props.warnings}
        extra={
          <>
            {props.jsonError && (
              <div className="problem problem-error">
                <strong>JSON error{props.jsonError.line ? ` (line ${props.jsonError.line})` : ''}:</strong> {props.jsonError.message}
              </div>
            )}
            {props.encodeErrors.map((e, i) => (
              <div key={i} className="problem problem-error">
                <code>{e.path}</code>: {e.message}
              </div>
            ))}
          </>
        }
      />
      <div className="tree-title">
        What gets serialized <span className="muted">— field-number order</span>
      </div>
      {props.overridden && (
        <div className="problem problem-warn">The wire carries hand-crafted bytes: this encoding is shown for reference but is <strong>not</strong> what is sent.</div>
      )}
      <EncodeTree nodes={props.nodes} typeName={props.typeName} follow={props.follow} />
    </section>
  );
}

export function ConsumerPanel(props: {
  label?: string;
  proto: string;
  onProto: (v: string) => void;
  linked: boolean;
  onUnlink: () => void;
  onLink: () => void;
  types: string[];
  typeName: string;
  onType: (t: string) => void;
  schemaError: SchemaError | null;
  warnings: string[];
  message: DecodedMessage | null;
  parseError: string | null;
  nodesByPath: Map<string, TraceNode[]>;
  follow: boolean;
  revealed: ((path: string) => boolean) | null;
  waiting: boolean;
}) {
  return (
    <section className="panel side-panel" aria-label="Consumer">
      <header className="panel-head">
        <div className="panel-title">
          <span className="role-dot role-consumer" />
          <h2>Consumer</h2>
          {props.label && <span className="version">{props.label}</span>}
          <span className="muted small">reads</span>
        </div>
        <TypeSelect types={props.types} value={props.typeName} onChange={props.onType} />
      </header>
      <div className="tabs">
        <span className="tab tab-on tab-static">
          Schema <span className="muted">.proto</span>
        </span>
        <span className="tab-spacer" />
        {props.linked ? (
          <button className="link-toggle" onClick={props.onUnlink} title="Give the consumer its own copy of the schema to edit">
            🔗 Same as producer · <strong>edit separately</strong>
          </button>
        ) : (
          <button className="link-toggle" onClick={props.onLink} title="Use the producer schema on both sides">
            Use producer schema
          </button>
        )}
      </div>
      <div className="editor-wrap">
        <CodeEditor
          language="proto"
          value={props.proto}
          onChange={props.linked ? undefined : props.onProto}
          readOnly={props.linked}
          errorLine={props.schemaError?.line}
          ariaLabel="Consumer schema"
        />
      </div>
      <Problems schemaError={props.linked ? null : props.schemaError} warnings={props.linked ? [] : props.warnings} />
      <div className="tree-title">
        What the consumer sees {props.parseError && <span className="badge badge-error">parse failed</span>}
      </div>
      {props.parseError && (
        <div className="problem problem-error">
          <Rich text={props.parseError} />
          <div className="small">Partial content below is what the parser had read before failing — real libraries discard it.</div>
        </div>
      )}
      {props.waiting ? (
        <div className="tree waiting">
          <div className="waiting-inner">⏳ Waiting for bytes…</div>
        </div>
      ) : (
        <DecodeTree message={props.message} nodesByPath={props.nodesByPath} follow={props.follow} revealed={props.revealed} />
      )}
    </section>
  );
}
