/** Same field number → same color on both sides, so the mapping is visible. */
export const PALETTE_SIZE = 10;

export function fieldColorClass(fieldNumber: number | undefined, kind?: string): string {
  if (kind === 'unknown') return 'fc-unknown';
  if (kind === 'error') return 'fc-error';
  if (fieldNumber === undefined) return 'fc-none';
  return `fc-${(fieldNumber - 1 + PALETTE_SIZE * 1000) % PALETTE_SIZE}`;
}
