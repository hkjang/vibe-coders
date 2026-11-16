import { useText2SqlQuery } from "./use-text2sql-query";

import { apiClient } from "@/shared/api/client";
import { endpoints } from "@/shared/api/endpoints";

export const text2sqlRouteId = "text2sql.overview";

export const text2sqlQueryKeys = {
  overview: (window: string) => ["text2sql", "overview", window] as const,
  connections: () => ["text2sql", "connections"] as const,
  features: () => ["text2sql", "features"] as const,
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

/** Load only the visible tab's reads; connection tests remain explicit actions. */
export function useText2SqlQueries({ minRisk, registrySchema, tab, window }: Text2SqlQueriesOptions) {
  const overview = useText2SqlQuery({
    key: text2sqlQueryKeys.overview(window),
    enabled: ["overview", "runtime", "schemas", "access", "golden"].includes(tab),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.overview, {
        query: { window },
        signal,
        routeId: text2sqlRouteId,
      }),
  });
  const connections = useText2SqlQuery({
    key: text2sqlQueryKeys.connections(),
    enabled: tab === "runtime" || tab === "schemas",
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.connections.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
  });
  const features = useText2SqlQuery({
    key: text2sqlQueryKeys.features(),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.features.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "runtime",
  });
  const glossary = useText2SqlQuery({
    key: text2sqlQueryKeys.glossary(),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.glossary.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "access",
  });
  const registry = useText2SqlQuery({
    key: text2sqlQueryKeys.registry(registrySchema),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.registry.tables, {
        query: { schema: registrySchema },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "schemas" && registrySchema !== "",
  });
  const riskQueue = useText2SqlQuery({
    key: text2sqlQueryKeys.riskQueue(window, minRisk),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.riskQueue, {
        query: { window, min_risk: minRisk },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "risk",
  });
  const anomalies = useText2SqlQuery({
    key: text2sqlQueryKeys.anomalies(window),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.anomalies, {
        query: { window },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "risk",
  });
  const miners = useText2SqlQuery({
    key: text2sqlQueryKeys.miners(),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.miners, {
        query: { window: "30d", min_count: 3 },
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "reports",
  });
  const reports = useText2SqlQuery({
    key: text2sqlQueryKeys.reports(),
    read: (signal) =>
      apiClient.request(endpoints.domains.text2sql.reports.list, {
        signal,
        routeId: text2sqlRouteId,
      }),
    enabled: tab === "reports",
  });

  const active = [
    overview,
    connections,
    features,
    glossary,
    registry,
    riskQueue,
    anomalies,
    miners,
    reports,
  ].filter((query) => query.active);
  return {
    active,
    anomalies,
    connections,
    features,
    glossary,
    miners,
    overview,
    registry,
    reports,
    riskQueue,
  } as const;
}
