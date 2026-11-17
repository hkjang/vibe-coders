export const traceRelatedQueryKeys = ["related_kind", "related_limit", "related_offset"] as const;
export function validTraceRelatedQueryValue(
  key: (typeof traceRelatedQueryKeys)[number],
  values: readonly string[],
): boolean {
  if (values.length !== 1) return false;
  const value = values[0] ?? "";
  if (key === "related_kind") return value === "workflow" || value === "app";
  if (key === "related_limit") return ["25", "50", "100"].includes(value);
  return /^(0|[1-9][0-9]{0,6})$/u.test(value) && Number(value) <= 1_000_000;
}
