import { describe, expect, it } from "vitest";

import { endpoints } from "@/shared/api/endpoints";
import { openApiOperations } from "@/shared/api/generated/paths.gen";

interface RouteView {
  readonly method: string;
  readonly path: string;
}

function isRouteView(value: unknown): value is RouteView {
  return (
    typeof value === "object" &&
    value !== null &&
    "method" in value &&
    typeof value.method === "string" &&
    "path" in value &&
    typeof value.path === "string"
  );
}

function endpointValues(value: object): RouteView[] {
  return Object.values(value).flatMap((entry) => {
    if (isRouteView(entry)) return [entry];
    return typeof entry === "object" && entry !== null ? endpointValues(entry) : [];
  });
}

describe("endpoints", () => {
  it("only contains path and method pairs declared by the generated OpenAPI contract", () => {
    const declaredOperations = new Set(openApiOperations.map(({ method, path }) => `${method} ${path}`));
    const configuredOperations = endpointValues(endpoints).map(({ method, path }) => `${method} ${path}`);

    expect(configuredOperations.length).toBeGreaterThan(0);
    expect(configuredOperations.filter((operation) => !declaredOperations.has(operation))).toEqual([]);
  });

  it("registers Phase 1 operations without page-owned URL strings", () => {
    expect([
      endpoints.health.path,
      endpoints.ready.path,
      endpoints.admin.stats.path,
      endpoints.admin.ops.status.path,
      endpoints.admin.ops.risk.path,
      endpoints.admin.routing.health.path,
    ]).toEqual([
      "/health",
      "/ready",
      "/admin/stats",
      "/admin/ops/status",
      "/admin/ops/risk",
      "/admin/routing/health",
    ]);
    expect(endpoints.health.querySchema).toBeUndefined();
    expect(endpoints.admin.routing.health.querySchema).toBeDefined();
  });
});
