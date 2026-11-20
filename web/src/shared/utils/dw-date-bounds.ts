export interface DwDateBounds {
  since_day: string;
  until_day: string;
}
export type DwDateSelection =
  { kind: "none" } | { kind: "invalid" } | { kind: "selected"; bounds: DwDateBounds };

const dayMs = 86_400_000;
const maxExclusive = "2149-06-07";

export function utcDay(value: string): number | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const milliseconds = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
    ? milliseconds
    : undefined;
}

export function validDwDateBounds(bounds: DwDateBounds): boolean {
  const start = utcDay(bounds.since_day);
  const end = utcDay(bounds.until_day);
  return (
    start !== undefined &&
    end !== undefined &&
    bounds.since_day >= "1970-01-01" &&
    bounds.until_day <= maxExclusive &&
    end > start &&
    end - start <= 90 * dayMs
  );
}

export function readDwDateSelection(parameters: URLSearchParams): DwDateSelection {
  const starts = parameters.getAll("since_day");
  const ends = parameters.getAll("until_day");
  if (!starts.length && !ends.length) return { kind: "none" };
  if (starts.length !== 1 || ends.length !== 1) return { kind: "invalid" };
  const bounds = { since_day: starts[0] ?? "", until_day: ends[0] ?? "" };
  return validDwDateBounds(bounds) ? { kind: "selected", bounds } : { kind: "invalid" };
}

/** A weekly point begins Monday, but the first week can start before the query window. */
export function dwPointBounds(day: string, bucket: string, since: string): DwDateBounds | undefined {
  const start = utcDay(day);
  const lower = utcDay(since);
  if (start === undefined || lower === undefined || !["day", "week"].includes(bucket)) return undefined;
  const end = new Date(start + (bucket === "week" ? 7 : 1) * dayMs).toISOString().slice(0, 10);
  const bounds = { since_day: day < since ? since : day, until_day: end > maxExclusive ? maxExclusive : end };
  return validDwDateBounds(bounds) ? bounds : undefined;
}

export function dwBoundsLabel(bounds: DwDateBounds): string {
  const last = new Date((utcDay(bounds.until_day) ?? 0) - dayMs).toISOString().slice(0, 10);
  return `${bounds.since_day}${last === bounds.since_day ? "" : ` ~ ${last}`} (UTC)`;
}
