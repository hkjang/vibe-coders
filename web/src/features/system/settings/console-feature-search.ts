import { migrationStatusLabels } from "@/config/ui-labels";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { featureTitles } from "./console-rollout-display";
import type { ConsoleFeatureRow } from "./settings-utils";

export const consoleFilterKeys = ["console_q", "console_status", "console_readonly"] as const;
export const consoleFilterReset = Object.fromEntries(consoleFilterKeys.map((key) => [key, null]));
export const consoleSearchMessages = {
  search: "전환 기능 검색",
  help: "현재 목록의 기능 이름과 등록 ID로 검색합니다.",
  invalid: "검색어는 비밀정보와 제어문자 없이 200자 이내로 입력하세요.",
  invalidRoute: "전환 기능의 조회 조건을 확인할 수 없습니다. 조건을 초기화한 뒤 다시 검색하세요.",
  reset: "전환 조회 조건 초기화",
  status: "전환 상태 필터",
  readonly: "쓰기 차단 설정",
} as const;

export function validConsoleSearch(value: string, prefixes: readonly string[]): boolean {
  return (
    [...value].length <= 200 && !/[\p{Cc}\p{Cs}]/u.test(value) && !containsPotentialSecret(value, prefixes)
  );
}

export function readConsoleFilters(params: URLSearchParams, prefixes: readonly string[]) {
  const query = params.get("console_q")?.trim() ?? "";
  const status = params.get("console_status") ?? "";
  const readonly = params.get("console_readonly") ?? "";
  const valid =
    consoleFilterKeys.every((key) => params.getAll(key).length <= 1) &&
    validConsoleSearch(query, prefixes) &&
    (status === "" || status === "unknown" || Object.hasOwn(migrationStatusLabels, status)) &&
    ["", "true", "false", "unknown"].includes(readonly);
  return { query, status, readonly, valid };
}

export function consoleReadonlyValue(row: ConsoleFeatureRow): "true" | "false" | "unknown" {
  const value = row.readonly?.value.trim().toLowerCase();
  return value === "true" || value === "false" ? value : "unknown";
}

export function filterConsoleFeatures(
  rows: readonly ConsoleFeatureRow[],
  filter: ReturnType<typeof readConsoleFilters>,
) {
  if (!filter.valid) return [];
  const needle = filter.query.normalize("NFC").toLocaleLowerCase("ko-KR");
  return rows.filter((row) => {
    const status = row.status?.value ?? "";
    const known = Object.hasOwn(migrationStatusLabels, status);
    return (
      (!needle ||
        [featureTitles.get(row.featureId) ?? "", row.featureId].some((value) =>
          value.normalize("NFC").toLocaleLowerCase("ko-KR").includes(needle),
        )) &&
      (!filter.status || (filter.status === "unknown" ? !known : status === filter.status)) &&
      (!filter.readonly || consoleReadonlyValue(row) === filter.readonly)
    );
  });
}
