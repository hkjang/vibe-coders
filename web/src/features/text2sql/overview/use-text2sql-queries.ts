import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";
import { useRefreshInterval } from "@/shared/hooks/use-refresh-interval";

export const text2sqlRouteId = "text2sql.overview";

export const text2sqlQueryKeys = {
  overview: (window: string) => ["text2sql", "overview", window] as const,
  connections: () => ["text2sql", "connections"] as const,
  features: () => ["text2sql", "features"] as const,
  killSwitch: () => ["text2sql", "kill-switch"] as const,
  glossary: () => ["text2sql", "glossary"] as const,
  registry: (schema: string) => ["text2sql", "registry", schema] as const,
  riskQueue: (window: string, minRisk: number) => ["text2sql", "risk-queue", window, minRisk] as const,
  anomalies: (window: string) => ["text2sql", "anomalies", window] as const,
  miners: () => ["text2sql", "miners"] as const,
  reports: () => ["text2sql", "reports"] as const,
} as const;

/** Query key prefixes invalidated after a write, grouped by what the write changed. */
export const text2sqlInvalidations = {
  overview: [["text2sql", "overview"]],
  connections: [
    ["text2sql", "connections"],
    ["text2sql", "overview"],
  ],
  features: [["text2sql", "features"]],
  killSwitch: [["text2sql", "kill-switch"]],
  glossary: [["text2sql", "glossary"]],
  registry: [["text2sql", "registry"]],
  reports: [
    ["text2sql", "reports"],
    ["text2sql", "miners"],
  ],
} as const;

export type Text2SqlTabId = "overview" | "runtime" | "schemas" | "access" | "risk" | "golden" | "reports";

interface Text2SqlQueriesOptions {
  minRisk: number;
  registrySchema: string;
  tab: Text2SqlTabId;
  window: string;
}

export interface Text2SqlQueries {
  anomalies: UseQueryResult<unknown>;
  connections: UseQueryResult<unknown>;
  features: UseQueryResult<unknown>;
  glossary: UseQueryResult<unknown>;
  killSwitch: UseQueryResult<unknown>;
  miners: UseQueryResult<unknown>;
  overview: UseQueryResult<unknown>;
  registry: UseQueryResult<unknown>;
  reports: UseQueryResult<unknown>;
  riskQueue: UseQueryResult<unknown>;
}

/**
 * Loads the Text2SQL console data. The overview, connection list and kill switch
 * back the page shell, so they always load; every other panel is fetched only
 * while its tab is open. The healthcheck is deliberately absent: it probes the
 * execute database, so it stays behind an explicit button.
 */
export function useText2SqlQueries({ minRisk, registrySchema, tab, window }: Text2SqlQueriesOptions) {
  const refetchInterval = useRefreshInterval();
  const shared = { refetchInterval, refetchIntervalInBackground: false } as const;

  const overview = useQuery({
    queryKey: text2sqlQueryKeys.overview(window),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.overview, {
        query: { window },
        signal,
        routeId: text2sqlRouteId,
      }),
    ...shared,
  });
  const connections = useQuery({
    queryKey: text2sqlQueryKeys.connections(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.connections.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    ...shared,
  });
  const killSwitch = useQuery({
    queryKey: text2sqlQueryKeys.killSwitch(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.killSwitch.read, {
        signal,
        routeId: text2sqlRouteId,
      }),
    ...shared,
  });
  const features = useQuery({
    queryKey: text2sqlQueryKeys.features(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.features.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "runtime",
    ...shared,
  });
  const glossary = useQuery({
    queryKey: text2sqlQueryKeys.glossary(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.glossary.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "access",
    ...shared,
  });
  const registry = useQuery({
    queryKey: text2sqlQueryKeys.registry(registrySchema),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.registry.tables, {
        query: { schema: registrySchema },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "schemas" && registrySchema !== "",
    ...shared,
  });
  const riskQueue = useQuery({
    queryKey: text2sqlQueryKeys.riskQueue(window, minRisk),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.riskQueue, {
        query: { window, min_risk: minRisk },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "risk",
    ...shared,
  });
  const anomalies = useQuery({
    queryKey: text2sqlQueryKeys.anomalies(window),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.anomalies, {
        query: { window },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "risk",
    ...shared,
  });
  const miners = useQuery({
    queryKey: text2sqlQueryKeys.miners(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.miners, {
        query: { window: "30d", min_count: 3 },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "reports",
    ...shared,
  });
  const reports = useQuery({
    queryKey: text2sqlQueryKeys.reports(),
    queryFn: ({ signal }) =>
      apiClient.request(endpoints.domains.text2sql.reports.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "reports",
    ...shared,
  });

  return {
    anomalies,
    connections,
    features,
    glossary,
    killSwitch,
    miners,
    overview,
    registry,
    reports,
    riskQueue,
  } as const;
}
