import { healthStatusLabels } from "@/config/ui-labels";
import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import type { ProviderList, ProviderSLOResponse, RoutingHealth } from "@/shared/api/schemas";
import { toCsv } from "@/shared/utils/csv";
import type { ProviderCatalogSort } from "@/shared/utils/provider-catalog-query";
import type { HealthRange } from "@/features/health/health-utils";
import {
  buildProviderRows,
  filterProviderRows,
  displayProviderBaseURL,
  displayProviderText,
  type ProviderCatalogRow,
  type ProviderStatusFilter,
} from "./provider-catalog";
import { sortProviderCatalogRows } from "./provider-table-state";

export interface ProviderExportFilters {
  query: string;
  status: ProviderStatusFilter;
  range: HealthRange;
  sort?: ProviderCatalogSort;
}

/** Fresh authorized reads, independent of the screen's potentially stale cache. */
export async function loadProviderExport(range: HealthRange, routingAllowed: boolean, signal: AbortSignal) {
  const options = { signal, routeId: "gateway.providers" };
  const [providers, slo, routing] = await Promise.all([
    apiClient.request(endpoints.admin.providers.list, options),
    apiClient.request(endpoints.admin.providers.slo, { ...options, query: { window: range } }),
    routingAllowed
      ? apiClient.request(endpoints.admin.routing.health, {
          ...options,
          query: { window: range, threshold: 70 },
        })
      : undefined,
  ]);
  return { providers, slo, routing };
}

export function providerExportCsv(
  snapshot: { providers: ProviderList; slo: ProviderSLOResponse; routing?: RoutingHealth },
  filters: ProviderExportFilters,
  prefixes: readonly string[],
  exportedAt: string,
): { csv: string; count: number } {
  const entries = snapshot.providers.providers;
  if (new Set(entries.map((provider) => provider.provider_ref)).size !== entries.length)
    throw new Error("Ambiguous provider export");
  const rows = buildProviderRows(
    entries,
    snapshot.slo.slos,
    snapshot.slo.evaluations,
    snapshot.routing,
    false,
    prefixes,
  ).sort(
    (left, right) =>
      left.provider.priority - right.provider.priority || left.displayName.localeCompare(right.displayName),
  );
  const selected = sortProviderCatalogRows(
    filterProviderRows(rows, filters.query, filters.status, prefixes),
    filters.sort,
  );
  const csv = toCsv<ProviderCatalogRow>(selected, [
    { header: "공급자", value: (row) => row.displayName },
    { header: "공급자 참조", value: (row) => row.provider.provider_ref },
    { header: "연결 URL (마스킹)", value: (row) => displayProviderBaseURL(row.provider.base_url, prefixes) },
    { header: "설정 상태", value: (row) => (row.provider.enabled ? "활성" : "비활성") },
    { header: "운영 상태", value: (row) => healthStatusLabels[row.health] },
    {
      header: "P95 지연 (ms)",
      value: (row) => row.routing?.p95_latency_ms ?? row.evaluation?.metrics.p95_latency_ms.actual,
    },
    { header: "모델 패턴", value: (row) => displayProviderText(row.provider.model_patterns, prefixes) },
    { header: "장애 전환 그룹", value: (row) => displayProviderText(row.provider.failover_group, prefixes) },
    { header: "우선순위", value: (row) => row.provider.priority },
    { header: "제한 시간 (ms)", value: (row) => row.provider.timeout_ms },
    { header: "비밀정보 설정 여부", value: (row) => (row.provider.api_key_configured ? "설정됨" : "없음") },
    { header: "운영 집계 기간", value: () => filters.range },
    { header: "내보낸 시각 (ISO 8601)", value: () => exportedAt },
  ]);
  return { csv, count: selected.length };
}
