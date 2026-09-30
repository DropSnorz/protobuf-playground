import type { Phase, Step } from '../proto/steps';

const PHASES: { id: Phase; label: string }[] = [
  { id: 'encode', label: 'Serialize' },
  { id: 'transmit', label: 'Transmit' },
  { id: 'decode', label: 'Deserialize' },
  { id: 'done', label: 'Result' },
];

export function PhaseBar({ phase, status }: { phase: Phase; status: Step['status'] }) {
  const idx = PHASES.findIndex((p) => p.id === phase);
  return (
    <ol className="phases">
      {PHASES.map((p, i) => (
        <li
          key={p.id}
          className={`phase ${i < idx ? 'phase-done' : ''} ${i === idx ? 'phase-active' : ''} ${
            i === idx && p.id === 'done' ? `phase-${status}` : ''
          }`}
        >
          <span className="phase-num">{i < idx ? '✓' : i + 1}</span>
          {p.label}
        </li>
      ))}
    </ol>
  );
}

export function Player(props: {
  index: number;
  count: number;
  playing: boolean;
  speed: number;
  onIndex: (i: number) => void;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (s: number) => void;
}) {
  const { index, count } = props;
  return (
    <div className="player">
      <div className="player-buttons">
        <button className="icon-btn" title="Restart (Home)" onClick={() => props.onIndex(0)} disabled={index === 0}>
          ⏮
        </button>
        <button className="icon-btn" title="Previous step (←)" onClick={() => props.onIndex(Math.max(0, index - 1))} disabled={index === 0}>
          ◀
        </button>
        {props.playing ? (
          <button className="play-btn" title="Pause (space)" onClick={props.onPause}>
            ❚❚ Pause
          </button>
        ) : (
          <button className="play-btn" title="Play (space)" onClick={props.onPlay}>
            ▶ {index >= count - 1 ? 'Replay' : 'Play'}
          </button>
        )}
        <button
          className="icon-btn"
          title="Next step (→)"
          onClick={() => props.onIndex(Math.min(count - 1, index + 1))}
          disabled={index >= count - 1}
        >
          ▶
        </button>
        <button className="icon-btn" title="Jump to result (End)" onClick={() => props.onIndex(count - 1)} disabled={index >= count - 1}>
          ⏭
        </button>
      </div>
      <input
        className="scrubber"
        type="range"
        min={0}
        max={Math.max(0, count - 1)}
        value={index}
        onChange={(e) => props.onIndex(Number(e.target.value))}
        aria-label="Timeline"
      />
      <span className="step-count">
        {index + 1}/{count}
      </span>
      <select className="speed" value={props.speed} onChange={(e) => props.onSpeed(Number(e.target.value))} aria-label="Speed">
        <option value={2200}>0.5×</option>
        <option value={1300}>1×</option>
        <option value={700}>2×</option>
        <option value={300}>4×</option>
      </select>
    </div>
  );
}
