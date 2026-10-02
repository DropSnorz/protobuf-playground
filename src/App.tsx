import { Menu } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BottomTabs } from './components/BottomTabs';
import { Brief } from './components/Brief';
import { HighlightContext, pathRelation, type Highlight, type HighlightCtx } from './components/highlight';
import { ConsumerPanel, ProducerPanel } from './components/SidePanels';
import { Sidebar } from './components/Sidebar';
import { WirePanel } from './components/WirePanel';
import { decode, toJson } from './proto/decoder';
import { diffSchemas } from './proto/diff';
import { encode } from './proto/encoder';
import { stringifyJson } from './proto/json';
import { matchTypeName, parseSchema } from './proto/schema';
import { buildSteps } from './proto/steps';
import { annotateBytes, walk, type Range, type TraceNode } from './proto/trace';
import { parseHex } from './proto/wire';
import { DEFAULT_SCENARIO_ID, scenarioById, type Scenario } from './scenarios';

interface Workspace {
  scenarioId: string | null;
  producerProto: string;
  producerType: string;
  consumerProto: string;
  consumerType: string;
  linked: boolean;
  valueText: string;
  wireHex: string | null;
}

function fromScenario(s: Scenario): Workspace {
  const c = s.consumer ?? s.producer;
  return {
    scenarioId: s.id,
    producerProto: s.producer.proto,
    producerType: s.producer.type,
    consumerProto: c.proto,
    consumerType: c.type,
    linked: !s.consumer,
    valueText: stringifyJson(s.value, 2),
    wireHex: s.wireHex ? (parseHex(s.wireHex) as Uint8Array).reduce((a, b) => a + b.toString(16).padStart(2, '0').toUpperCase() + ' ', '').trim() : null,
  };
}

const b64url = {
  dec(s: string) {
    const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  },
};

function initialWorkspace(): Workspace {
  const hash = window.location.hash.slice(1);
  const params = new URLSearchParams(hash);
  const w = params.get('w');
  if (w) {
    try {
      const ws = JSON.parse(b64url.dec(w)) as Workspace;
      if (typeof ws.producerProto === 'string' && typeof ws.valueText === 'string') return ws;
    } catch {
      /* ignore malformed links */
    }
  }
  // `#s=id`, or a bare `#id` (some embedding hosts only forward plain anchors).
  const s = scenarioById(params.get('s')) ?? scenarioById(hash) ?? scenarioById(DEFAULT_SCENARIO_ID)!;
  return fromScenario(s);
}

function setUrl(url: string) {
  try {
    window.history.replaceState(null, '', url);
  } catch {
    /* sandboxed frames may refuse history updates */
  }
}

function jsonErrorLine(msg: string, text: string): number | undefined {
  const m = /line (\d+)/.exec(msg);
  if (m) return Number(m[1]);
  const pos = /position (\d+)/.exec(msg);
  if (pos) return text.slice(0, Number(pos[1])).split('\n').length;
  return undefined;
}

export default function App() {
  const [ws, setWs] = useState<Workspace>(initialWorkspace);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1300);
  const [hover, setHover] = useState<Highlight | null>(null);
  const [hoverByte, setHoverByte] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  // Bumped whenever the workspace is replaced from outside the editors, to remount them
  // (the CodeMirror wrapper may ignore external value changes right after user input).
  const [epoch, setEpoch] = useState(0);

  const scenario = scenarioById(ws.scenarioId);
  const modified = useMemo(() => {
    if (!scenario) return true;
    const base = fromScenario(scenario);
    return (Object.keys(base) as (keyof Workspace)[]).some((k) => base[k] !== ws[k]);
  }, [ws, scenario]);

  const update = (patch: Partial<Workspace>) => setWs((w) => ({ ...w, ...patch }));

  // ---- derived model ---------------------------------------------------------
  const consumerSource = ws.linked ? ws.producerProto : ws.consumerProto;
  const pParse = useMemo(() => parseSchema(ws.producerProto), [ws.producerProto]);
  const cParse = useMemo(() => (ws.linked ? pParse : parseSchema(consumerSource)), [ws.linked, pParse, consumerSource]);
  const pSchema = pParse.ok ? pParse.schema : null;
  const cSchema = cParse.ok ? cParse.schema : null;
  const pType = (pSchema && matchTypeName(pSchema, ws.producerType)) ?? ws.producerType;
  const cType = (cSchema && matchTypeName(cSchema, ws.consumerType)) ?? ws.consumerType;

  const jsonParsed = useMemo(() => {
    try {
      return { ok: true as const, value: JSON.parse(ws.valueText) as unknown };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: { message: msg, line: jsonErrorLine(msg, ws.valueText) } };
    }
  }, [ws.valueText]);

  const enc = useMemo(
    () => (pSchema && jsonParsed.ok && pSchema.messages.has(pType) ? encode(pSchema, pType, jsonParsed.value) : null),
    [pSchema, pType, jsonParsed],
  );
  const overrideBytes = useMemo(() => {
    if (ws.wireHex === null) return null;
    const b = parseHex(ws.wireHex);
    return typeof b === 'string' ? new Uint8Array() : b;
  }, [ws.wireHex]);
  const bytes = overrideBytes ?? enc?.bytes ?? new Uint8Array();
  const dec = useMemo(() => (cSchema && cSchema.messages.has(cType) ? decode(cSchema, cType, bytes) : null), [cSchema, cType, bytes]);

  const steps = useMemo(
    () => buildSteps({ enc, dec, bytes, override: overrideBytes !== null, producerType: pType, consumerType: cType }),
    [enc, dec, bytes, overrideBytes, pType, cType],
  );
  const pAnn = useMemo(() => (enc && !overrideBytes ? annotateBytes(enc.nodes, bytes.length) : null), [enc, overrideBytes, bytes]);
  const cAnn = useMemo(() => (dec ? annotateBytes(dec.nodes, bytes.length) : new Array(bytes.length).fill(null)), [dec, bytes]);
  const diff = useMemo(
    () => (pSchema && cSchema && !ws.linked && pSchema.messages.has(pType) && cSchema.messages.has(cType) ? diffSchemas(pSchema, pType, cSchema, cType) : []),
    [pSchema, cSchema, pType, cType, ws.linked],
  );

  // index maps for highlighting
  const producerById = useMemo(() => {
    const m = new Map<string, TraceNode>();
    if (enc) walk(enc.nodes, (n) => m.set(n.id, n));
    return m;
  }, [enc]);
  const consumerByPath = useMemo(() => {
    const m = new Map<string, TraceNode[]>();
    if (dec) walk(dec.nodes, (n) => m.set(n.path, [...(m.get(n.path) ?? []), n]));
    return m;
  }, [dec]);

  // Links like #s=maps pasted into the address bar.
  useEffect(() => {
    const onHash = () => {
      setWs(initialWorkspace());
      setEpoch((e) => e + 1);
      setHover(null);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  // New model → jump to the final state (no animation while typing).
  useEffect(() => {
    setIndex(steps.length - 1);
    setPlaying(false);
  }, [steps]);

  // playback
  useEffect(() => {
    if (!playing) return;
    if (index >= steps.length - 1) {
      setPlaying(false);
      return;
    }
    const slow = steps[index].phase === 'transmit' ? 2.2 : 1;
    const t = window.setTimeout(() => setIndex((i) => Math.min(i + 1, steps.length - 1)), speed * slow);
    return () => window.clearTimeout(t);
  }, [playing, index, steps, speed]);

  const play = useCallback(() => {
    setIndex((i) => (i >= steps.length - 1 ? 0 : i));
    setPlaying(true);
  }, [steps.length]);

  // keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.cm-editor, input, textarea, select, button')) return;
      if (e.key === ' ') {
        e.preventDefault();
        if (playing) setPlaying(false);
        else play();
      } else if (e.key === 'ArrowRight') {
        setPlaying(false);
        setIndex((i) => Math.min(i + 1, steps.length - 1));
      } else if (e.key === 'ArrowLeft') {
        setPlaying(false);
        setIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Home') {
        setIndex(0);
      } else if (e.key === 'End') {
        setIndex(steps.length - 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [playing, play, steps.length]);

  // `index` may briefly exceed a freshly shrunk timeline (reset happens in an effect).
  const idx = Math.min(index, steps.length - 1);
  const step = steps[idx];
  const atEnd = step.phase === 'done';

  const hl: HighlightCtx = useMemo(
    () => ({
      active: atEnd
        ? { ranges: [] }
        : { producerId: step.producerNodeId, consumerPath: step.consumerPath, ranges: step.range ? [step.range] : [] },
      hover,
      setHover,
      producerRange: (id: string) => {
        const n = producerById.get(id);
        return n && n.end > n.start ? [{ start: n.start, end: n.end }] : [];
      },
      consumerRanges: (path: string) => {
        const out: Range[] = [];
        for (const [p, ns] of consumerByPath) {
          if (pathRelation(path, p)) ns.forEach((n) => out.push({ start: n.start, end: n.end }));
        }
        return out;
      },
    }),
    [atEnd, step, hover, producerById, consumerByPath],
  );

  const onHoverByte = (offset: number | null) => {
    setHoverByte(offset);
    if (offset === null) return setHover(null);
    const p = pAnn?.[offset];
    const c = cAnn[offset];
    const ranges: Range[] = [];
    const leaf = c?.node ?? p?.node;
    if (leaf) ranges.push({ start: leaf.start, end: leaf.end });
    setHover({ producerId: p?.node.id, consumerPath: c?.node.path, ranges });
  };

  // consumer tree progressive reveal
  const revealed = useMemo(() => {
    if (step.phase === 'done') return null;
    const paths: string[] = [];
    for (let i = 0; i <= idx; i++) if (steps[i].phase === 'decode' && steps[i].consumerPath) paths.push(steps[i].consumerPath!);
    return (path: string) => paths.some((rp) => pathRelation(path, rp) !== null);
  }, [steps, idx, step.phase]);

  const selectScenario = (id: string) => {
    const s = scenarioById(id);
    if (!s) return;
    setWs(fromScenario(s));
    setEpoch((e) => e + 1);
    setHover(null);
    setMenuOpen(false);
    setUrl(`#s=${id}`);
  };

  const errorRange = dec && !dec.ok && dec.error ? { start: dec.error.offset, end: dec.error.end } : undefined;
  const hoverRanges = hover?.ranges ?? [];

  return (
    <HighlightContext.Provider value={hl}>
      <div className={`app ${menuOpen ? 'menu-open' : ''}`}>
        <Sidebar current={ws.scenarioId} onSelect={selectScenario} modified={modified} />
        <div className="scrim" onClick={() => setMenuOpen(false)} />
        <main className="main">
          <button className="menu-btn" onClick={() => setMenuOpen(true)} aria-label="Open scenarios">
            <Menu size={16} /> Scenarios
          </button>
          <Brief
            scenario={scenario}
            modified={modified}
            onReset={() => scenario && selectScenario(scenario.id)}
          />
          <div className="columns">
            <ProducerPanel
              key={`p${epoch}`}
              label={scenario && !modified ? scenario.producer.label : undefined}
              proto={ws.producerProto}
              onProto={(v) => update({ producerProto: v })}
              valueText={ws.valueText}
              onValue={(v) => update({ valueText: v })}
              types={pSchema?.messageNames ?? []}
              typeName={pType}
              onType={(t) => setWs((w) => ({ ...w, producerType: t, consumerType: w.linked && w.consumerType === w.producerType ? t : w.consumerType }))}
              schemaError={pParse.ok ? null : pParse.error}
              warnings={pParse.ok ? pParse.warnings : []}
              jsonError={jsonParsed.ok ? null : jsonParsed.error}
              encodeErrors={enc?.errors ?? []}
              nodes={enc?.nodes ?? []}
              follow={playing}
              overridden={overrideBytes !== null}
            />
            <WirePanel
              steps={steps}
              index={idx}
              playing={playing}
              speed={speed}
              onIndex={(i) => {
                setPlaying(false);
                setIndex(i);
              }}
              onPlay={play}
              onPause={() => setPlaying(false)}
              onSpeed={setSpeed}
              bytes={bytes}
              producerAnn={pAnn}
              consumerAnn={cAnn}
              hoverRanges={hoverRanges}
              onHoverByte={onHoverByte}
              hoverByte={hoverByte}
              override={ws.wireHex}
              onOverride={(hex) => update({ wireHex: hex })}
              errorRange={errorRange}
            />
            <ConsumerPanel
              key={`c${epoch}`}
              label={scenario && !modified ? scenario.consumer?.label : undefined}
              proto={consumerSource}
              onProto={(v) => update({ consumerProto: v })}
              linked={ws.linked}
              onUnlink={() => {
                update({ linked: false, consumerProto: ws.producerProto });
                setEpoch((e) => e + 1);
              }}
              onLink={() => {
                update({ linked: true, consumerType: ws.producerType });
                setEpoch((e) => e + 1);
              }}
              types={cSchema?.messageNames ?? []}
              typeName={cType}
              onType={(t) => update({ consumerType: t })}
              schemaError={cParse.ok ? null : cParse.error}
              warnings={cParse.ok ? cParse.warnings : []}
              message={dec?.message ?? null}
              parseError={dec && !dec.ok && (step.phase === 'done' || step.status === 'error') ? dec.error!.message : null}
              nodesByPath={consumerByPath}
              follow={playing}
              revealed={revealed}
              waiting={step.phase === 'encode' || step.phase === 'transmit'}
            />
          </div>
          <BottomTabs
            bytes={bytes}
            pAnn={pAnn}
            cAnn={cAnn}
            diff={diff}
            linked={ws.linked}
            json={(inc) => (dec?.message && cSchema ? stringifyJson(toJson(dec.message, inc, cSchema), 2) : dec?.error?.message ?? '-')}
            steps={steps}
            index={idx}
            onIndex={(i) => {
              setPlaying(false);
              setIndex(i);
            }}
          />
          <footer className="foot">
            Encoding & decoding are implemented from
            scratch in TypeScript following the{' '}
            <a href="https://protobuf.dev/programming-guides/encoding/" target="_blank" rel="noreferrer">
              protobuf encoding spec
            </a>
            ; <code>.proto</code> parsing uses protobuf.js.
          </footer>
        </main>
      </div>
    </HighlightContext.Provider>
  );
}
