import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { withPathParams } from "@/shared/api/endpoint-factory";
import { adminIpsSchema, adminIpDetailSchema } from "@/shared/api/domains/ip-usage.schemas";
import { ipRouteId, ipUsageError, safeIpLabel, validIpIdentity, validIpText } from "./ip-usage-model";
const api = endpoints.domains.access.ips;
type Scope = { signal: AbortSignal; prefixes: readonly string[] };
const options = (scope: Scope) => ({ signal: scope.signal, routeId: ipRouteId, cache: "no-store" as const });
export async function readIpList(scope: Scope) {
  const data = adminIpsSchema.parse(await apiClient.request(api.list, options(scope)));
  const rows = data.ips.filter((row) => validIpIdentity(row.ip, scope.prefixes));
  if (new Set(rows.map((row) => row.ip)).size !== rows.length) throw ipUsageError();
  return {
    ips: rows.map((row) => ({ ...row, last_seen: safeIpLabel(row.last_seen, scope.prefixes) })),
    excluded: data.ips.length - rows.length,
  };
}
export async function readIpDetail(scope: Scope, ip: string) {
  if (!validIpIdentity(ip, scope.prefixes)) throw ipUsageError();
  const data = adminIpDetailSchema.parse(
    await apiClient.request(withPathParams(api.detail, { ip }), { ...options(scope), query: { limit: 100 } }),
  );
  if (data.stats.ip !== ip || data.recent?.some((row) => !validIpText(row.id, scope.prefixes, 512)))
    throw ipUsageError();
  if (data.recent && new Set(data.recent.map((row) => row.id)).size !== data.recent.length)
    throw ipUsageError();
  return {
    stats: { ...data.stats, last_seen: safeIpLabel(data.stats.last_seen, scope.prefixes) },
    daily: data.daily?.map((row) => ({ ...row, date: safeIpLabel(row.date, scope.prefixes) })),
    by_model: data.by_model?.map((row) => ({ ...row, key: safeIpLabel(row.key, scope.prefixes) })),
    by_key: data.by_key?.map((row) => ({ ...row, key: safeIpLabel(row.key, scope.prefixes) })),
    by_language: data.by_language?.map((row) => ({
      ...row,
      language: safeIpLabel(row.language, scope.prefixes),
    })),
    recent: data.recent?.map((row) => ({
      ...row,
      model: safeIpLabel(row.model, scope.prefixes),
      created_at: safeIpLabel(row.created_at, scope.prefixes),
    })),
  };
}
