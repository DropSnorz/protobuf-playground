export type Verdict = 'learn' | 'compatible' | 'caution' | 'breaking';

export interface Side {
  proto: string;
  type: string;
  /** e.g. "v2", "old service" */
  label?: string;
}

export interface Scenario {
  id: string;
  category: string;
  title: string;
  verdict: Verdict;
  /** One-liner shown in the sidebar tooltip and brief. */
  summary: string;
  /** Paragraphs; supports `code`, **bold** and *italic*. */
  description: string[];
  /** "What to watch" bullets. */
  observe: string[];
  producer: Side;
  /** Omitted → the consumer shares the producer schema. */
  consumer?: Side;
  value: unknown;
  /** Hand-crafted bytes replacing the producer's output. */
  wireHex?: string;
  /** Expected parse outcome (used by tests). */
  expect?: 'ok' | 'fail';
}
