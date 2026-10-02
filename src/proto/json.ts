/** JSON.stringify, except that -0 stays `-0` (plain JSON.stringify writes it as `0`). */
export function stringifyJson(value: unknown, space?: number): string {
  const NEG_ZERO = '__pb_negative_zero__';
  return JSON.stringify(value, (_, v) => (Object.is(v, -0) ? NEG_ZERO : v), space).replaceAll(`"${NEG_ZERO}"`, '-0');
}
