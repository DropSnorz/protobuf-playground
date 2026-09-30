import { createContext, useContext } from 'react';
import type { Range } from '../proto/trace';

export interface Highlight {
  producerId?: string;
  consumerPath?: string;
  ranges: Range[];
}

export interface HighlightCtx {
  /** Highlight driven by the current animation step. */
  active: Highlight;
  /** Highlight driven by mouse hover (takes precedence). */
  hover: Highlight | null;
  setHover: (h: Highlight | null) => void;
  /** Producer node id -> byte range; consumer path -> ranges. */
  producerRange: (id: string) => Range[];
  consumerRanges: (path: string) => Range[];
}

export const HighlightContext = createContext<HighlightCtx>({
  active: { ranges: [] },
  hover: null,
  setHover: () => {},
  producerRange: () => [],
  consumerRanges: () => [],
});

export const useHighlight = () => useContext(HighlightContext);

/** Is `path` equal to, or an ancestor of, `target`? */
export function pathRelation(path: string, target: string | undefined): 'self' | 'ancestor' | null {
  if (!target) return null;
  if (path === target) return 'self';
  if (target.startsWith(path) && (target[path.length] === '.' || target[path.length] === '[')) return 'ancestor';
  return null;
}
