import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { isValidIPAddress } from "@/shared/utils/ip-address";
import { formatNumber, formatKRW } from "@/shared/utils/format";
import type { DataTableSort } from "@/shared/data-table/DataTable";

export const ipRouteId = "access.users";
export function validIpText(value: string, prefixes: readonly string[], max = 200) {
  return (
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !/\p{C}/u.test(value) &&
    !containsPotentialSecret(value, prefixes)
  );
}
export function validIpIdentity(value: string, prefixes: readonly string[]) {
  // Validate without normalizing: historical IPv6 groups use the stored spelling.
  return validIpText(value, prefixes, 128) && !/[\\/[\]?#]/u.test(value) && isValidIPAddress(value);
}
export function safeIpLabel(value: string, prefixes: readonly string[]) {
  return value && !validIpText(value, prefixes, 8192) ? "민감하거나 잘못된 값은 숨겼습니다." : value;
}
export const ipNumber = (value?: number) => (value === undefined ? "미확인" : formatNumber(value));
export const ipCost = (value?: number) => (value === undefined ? "미확인" : formatKRW(value));
export const ipLatency = (value?: number) => (value === undefined ? "미확인" : `${formatNumber(value, 1)}ms`);
export const ipIdentityLabel = (value: string) => (value === "unknown" ? "IP 미기록" : value);
export function ipUsageError() {
  return new AppError("IP 사용량 응답의 대상 또는 형식을 확인하지 못했습니다. 다시 조회하세요.", {
    kind: "contract",
    code: "ip_usage_invalid",
  });
}
export function safeIpError(error: unknown, prefixes: readonly string[]) {
  return new AppError("IP 사용량을 불러오지 못했습니다. 다시 조회하세요.", {
    kind: isAppError(error) ? error.kind : "contract",
    status: isAppError(error) ? error.status : undefined,
    requestId:
      isAppError(error) && error.requestId && validIpText(error.requestId, prefixes, 512)
        ? error.requestId
        : undefined,
  });
}
export function sumIpMetric<Row>(rows: readonly Row[], value: (row: Row) => number | undefined) {
  let total = 0;
  for (const row of rows) {
    const n = value(row);
    if (n === undefined) return undefined;
    total += n;
  }
  return Number.isFinite(total) ? total : undefined;
}
export function readIpSort(raw: string | null, columns: readonly string[]): readonly DataTableSort[] {
  if (!raw || raw.length > 512) return [];
  const result: DataTableSort[] = [];
  for (const part of raw.split(",")) {
    const [columnId, direction, extra] = part.split(":");
    if (
      !columnId ||
      extra !== undefined ||
      !columns.includes(columnId) ||
      !["asc", "desc"].includes(direction ?? "") ||
      result.some((row) => row.columnId === columnId)
    )
      return [];
    result.push({ columnId, direction: direction === "desc" ? "desc" : "asc" });
  }
  return result;
}
