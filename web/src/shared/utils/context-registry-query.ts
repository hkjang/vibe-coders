export const contextSortFields = ["key", "name", "enabled", "token_estimate", "use_count"] as const;
export function validContextSort(value: string): boolean {
  if (value === "") return true;
  const parts = value.split(",");
  const fields = parts.map((part) => part.split(":"));
  return (
    parts.length <= 3 &&
    new Set(fields.map((pair) => pair[0])).size === fields.length &&
    fields.every(
      ([field, direction, ...extra]) =>
        contextSortFields.some((item) => item === field) &&
        (direction === "asc" || direction === "desc") &&
        extra.length === 0,
    )
  );
}
