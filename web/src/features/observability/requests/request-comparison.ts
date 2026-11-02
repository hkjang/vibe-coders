import { apiClient } from "@/shared/api/client";
import { appRequestsContractHeaders } from "@/shared/api/app-request-contract";
import { endpoints } from "@/shared/api/endpoints";
import { AppError } from "@/shared/api/error";
import type { AppRequestSummary } from "@/shared/api/schemas";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { requestQueryFieldError } from "@/shared/utils/request-query-filters";

export function comparisonIdError(value: string, prefixes: readonly string[]): string | undefined {
  if (!value) return "비교할 요청 ID를 입력하세요.";
  if (containsPotentialSecret(value, prefixes)) return "비밀정보로 보이는 값은 요청 ID로 조회할 수 없습니다.";
  return requestQueryFieldError("request_id", value);
}

/** Only the strict, body-free app projection. Never call the legacy raw-detail diff endpoint. */
export async function loadRequestComparison(
  selected: AppRequestSummary,
  otherId: string,
  prefixes: readonly string[],
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<{ left: AppRequestSummary; right: AppRequestSummary }> {
  const assertActive = () => {
    assertCurrent();
    if (signal.aborted) throw new AppError("비교 조회가 취소되었습니다.", { kind: "aborted" });
  };
  assertActive();
  if (
    !selected.request_filterable ||
    comparisonIdError(selected.request_id, prefixes) ||
    comparisonIdError(otherId, prefixes)
  )
    throw new AppError("안전한 요청 ID를 확인하세요.", { kind: "contract" });
  const read = async (id: string) => {
    assertActive();
    const result = await apiClient.request(endpoints.admin.requests, {
      query: { request_id: id, limit: 2 },
      headers: appRequestsContractHeaders,
      signal,
      routeId: "observability.requests",
    });
    assertActive();
    const row = result.requests[0];
    if (
      result.request_contract_version !== 2 ||
      result.requests.length !== 1 ||
      result.next_cursor ||
      result.previous_cursor ||
      !row?.request_filterable ||
      row.request_id !== id
    )
      throw new AppError("요청을 유일하게 확인할 수 없습니다.", { kind: "contract" });
    return row;
  };
  const left = await read(selected.request_id);
  if (left.request_ref !== selected.request_ref || left.created_at !== selected.created_at)
    throw new AppError("목록에서 요청을 다시 선택하세요.", { kind: "contract" });
  const right = selected.request_id === otherId ? left : await read(otherId);
  assertActive();
  return { left, right };
}
