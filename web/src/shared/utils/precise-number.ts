const numbers = new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 6 });

/** Keep small nonzero measurements visible; exports retain the API number. */
export function formatPreciseNumber(value: number): string {
  if (!Number.isFinite(value)) return "확인 불가";
  if (value === 0) return "0";
  if (Math.abs(value) < 0.000001) return value.toExponential(4);
  return numbers.format(value);
}
