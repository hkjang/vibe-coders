import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { AppError, isAppError } from "@/shared/api/error";
import { containsPotentialSecret } from "@/shared/security/secrets";
import { toCsv } from "@/shared/utils/csv";
import type { ModelCatalogSort } from "@/shared/utils/model-catalog-query";
import type { HealthRange } from "@/features/health/health-utils";
import {
  buildModelRows,
  filterModelRows,
  modelRowKey,
  type ModelCatalogRow,
  type ModelStatusFilter,
} from "./model-catalog";
import {
  defaultModelCatalogOrder,
  observedModelSuccessRate,
  sortModelCatalogRows,
} from "./model-catalog-table-state";
import { modelSourceLabels, modelStatusPresentation } from "./model-presentation";

export interface ModelExportFilters {
  query: string;
  provider: string;
  status: ModelStatusFilter;
  range: HealthRange;
  sort?: ModelCatalogSort;
}

/** Independent fresh reads; never turn a failed request into a cached export. */
export async function loadModelExport(range: HealthRange, signal: AbortSignal) {
  const options = { signal, routeId: "gateway.models" };
  let rejectDenied!: (error: AppError) => void;
  const denied = new Promise<never>((_, reject) => {
    rejectDenied = reject;
  });
  const observe = <T>(read: Promise<T>): Promise<T> =>
    read.catch((cause: unknown) => {
      if (isAppError(cause) && (cause.status === 401 || cause.status === 403)) rejectDenied(cause);
      throw cause;
    });
  // A transient failure must not mask a sibling authorization denial. Wait for
  // ordinary outcomes, but publish any denial immediately even if another read
  // is still pending. The export owner then conceals data and aborts siblings.
  const outcomes = Promise.allSettled([
    observe(apiClient.request(endpoints.admin.models.list, options)),
    observe(apiClient.request(endpoints.admin.models.quality, { ...options, query: { window: range } })),
    observe(apiClient.request(endpoints.admin.models.pricing, options)),
    observe(apiClient.request(endpoints.admin.models.tags, options)),
  ]);
  const [catalogue, quality, pricing, tags] = await Promise.race([outcomes, denied]);
  const value = <T>(result: PromiseSettledResult<T>): T => {
    if (result.status === "rejected") throw result.reason;
    return result.value;
  };
  return { catalogue: value(catalogue), quality: value(quality), pricing: value(pricing), tags: value(tags) };
}

export function modelExportCsv(
  snapshot: Awaited<ReturnType<typeof loadModelExport>>,
  filters: ModelExportFilters,
  prefixes: readonly string[],
  exportedAt: string,
): { csv: string; count: number; partial: boolean } {
  const { catalogue, quality, pricing, tags } = snapshot;
  if (containsPotentialSecret(filters.query, prefixes))
    throw new AppError("검색 조건을 다시 확인하세요.", { kind: "contract" });
  if (new Set(catalogue.models.map(modelRowKey)).size !== catalogue.models.length)
    throw new AppError("모델 목록을 다시 확인하세요.", { kind: "contract" });
  const rows = buildModelRows(catalogue, quality, pricing, tags.tags).sort(defaultModelCatalogOrder);
  const selected = sortModelCatalogRows(
    filterModelRows(rows, filters.query, filters.provider, filters.status),
    filters.sort,
  );
  const partial =
    catalogue.partial_failures.length > 0 ||
    catalogue.providers.some((provider) => provider.status !== "ok" || provider.stale) ||
    catalogue.models.some((model) => model.stale);
  const text = (value: string) =>
    containsPotentialSecret(value, prefixes) ? "민감한 값은 표시하지 않습니다." : value;
  const csv = toCsv<ModelCatalogRow>(selected, [
    { header: "모델", value: (row) => text(row.model.id) },
    { header: "공급자", value: (row) => text(row.providerLabel) },
    { header: "공급자 참조", value: (row) => text(row.model.provider_ref) },
    { header: "출처", value: (row) => modelSourceLabels[row.model.source] },
    { header: "상태", value: (row) => modelStatusPresentation[row.status].label },
    { header: "품질 점수", value: (row) => row.quality?.quality_score },
    { header: "관측 요청 수", value: (row) => row.quality?.requests },
    { header: "성공률 (0–1)", value: observedModelSuccessRate },
    { header: "입력 가격 (원/백만 토큰)", value: (row) => row.price?.input_krw_per_1m },
    { header: "출력 가격 (원/백만 토큰)", value: (row) => row.price?.output_krw_per_1m },
    { header: "캐시 입력 가격 (원/백만 토큰)", value: (row) => row.price?.cached_input_krw_per_1m },
    { header: "품질 조회 기간", value: () => filters.range },
    { header: "수신 범위", value: () => (partial ? "부분 응답 또는 이전 데이터 포함" : "현재 수신 목록") },
    { header: "내보낸 시각 (ISO 8601)", value: () => exportedAt },
  ]);
  return { csv, count: selected.length, partial };
}
