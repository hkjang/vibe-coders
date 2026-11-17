import { containsPotentialSecret } from "@/shared/security/secrets";

export const runSortFields = [
  "created_at",
  "id",
  "status",
  "total_cases",
  "failed_cases",
  "risk_score",
  "cost_krw",
] as const;
export const runStatuses = ["running", "passed", "failed", "warning", "stopped"] as const;
export const runModes = ["dry-run", "active-controlled"] as const;
export const runKinds = ["campaign", "replay"] as const;
export const runFilterKeys = [
  "runs_status",
  "runs_mode",
  "runs_kind",
  "runs_run_id",
  "runs_campaign_id",
  "runs_source_result_id",
  "runs_review_id",
  "runs_from",
  "runs_to",
  "runs_sort",
  "runs_page",
  "runs_size",
] as const;
export const runQueryKeys = [...runFilterKeys, "run"] as const;

export function validRunSort(value: string): boolean {
  if (!value) return true;
  const pairs = value.split(",").map((part) => part.split(":"));
  return (
    pairs.length <= 3 &&
    new Set(pairs.map(([field]) => field)).size === pairs.length &&
    pairs.every(
      ([field, direction, ...extra]) =>
        runSortFields.some((item) => item === field) &&
        (direction === "asc" || direction === "desc") &&
        extra.length === 0,
    )
  );
}
export function validRunRef(value: string, prefixes: readonly string[] = []): boolean {
  return (
    !value ||
    (/^[\p{L}\p{N}._:-]+$/u.test(value) &&
      [...value].length <= 256 &&
      !containsPotentialSecret(value, prefixes))
  );
}
// Preserve sub-millisecond boundaries; Date.parse alone rounds nanoseconds away.
export function runTimestamp(value: string): bigint | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) return undefined;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  )
    return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return undefined;
  const zone = match[8] ?? "";
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms)
    ? BigInt(Math.floor(ms / 1000)) * 1_000_000_000n + BigInt((match[7] ?? "").padEnd(9, "0"))
    : undefined;
}
export function validRunWindow(from: string, to: string): boolean {
  if (!from && !to) return true;
  const start = runTimestamp(from),
    end = runTimestamp(to);
  return start !== undefined && end !== undefined && start < end;
}
export function readRunQuery(params: URLSearchParams, prefixes: readonly string[]) {
  const value = (key: string) => params.get(key) ?? "";
  const status = value("runs_status"),
    mode = value("runs_mode"),
    kind = value("runs_kind");
  const run_id = value("runs_run_id"),
    campaign_id = value("runs_campaign_id"),
    source_result_id = value("runs_source_result_id"),
    review_id = value("runs_review_id");
  const from = value("runs_from"),
    to = value("runs_to"),
    sort = value("runs_sort"),
    selected = value("run");
  const size = Number(params.get("runs_size") ?? "25"),
    page = Number(params.get("runs_page") ?? "1");
  const valid =
    runQueryKeys.every((key) => params.getAll(key).length <= 1) &&
    (!status || runStatuses.some((item) => item === status)) &&
    (!mode || runModes.some((item) => item === mode)) &&
    (!kind || runKinds.some((item) => item === kind)) &&
    [run_id, campaign_id, source_result_id, review_id, selected].every((id) => validRunRef(id, prefixes)) &&
    validRunWindow(from, to) &&
    validRunSort(sort) &&
    [25, 50, 100].includes(size) &&
    (!params.has("runs_size") || String(size) === value("runs_size")) &&
    Number.isInteger(page) &&
    page >= 1 &&
    (page - 1) * size <= 1_000_000 &&
    (!params.has("runs_page") || String(page) === value("runs_page"));
  return {
    valid,
    selected,
    size,
    page,
    query: {
      view: "page" as const,
      limit: size,
      offset: (page - 1) * size,
      ...(status ? { status: status as (typeof runStatuses)[number] } : {}),
      ...(mode ? { mode: mode as (typeof runModes)[number] } : {}),
      ...(kind ? { kind: kind as (typeof runKinds)[number] } : {}),
      ...(run_id ? { run_id } : {}),
      ...(campaign_id ? { campaign_id } : {}),
      ...(source_result_id ? { source_result_id } : {}),
      ...(review_id ? { review_id } : {}),
      ...(from ? { from, to } : {}),
      ...(sort ? { sort } : {}),
    },
  };
}
