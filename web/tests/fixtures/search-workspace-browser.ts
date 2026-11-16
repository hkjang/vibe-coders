import type { Page } from "@playwright/test";
import { migrationRegistry } from "../../src/config/migration-registry";
import { resourceSearchTargets } from "../../src/app/layouts/resource-search-items";
import type { ResourceKind } from "../../src/shared/api/resource-search";
import { installSettingsWorkspace, runtimeKey } from "./settings-workspace-browser";

export async function installSearchWorkspace(page: Page) {
  const fixture = await installSettingsWorkspace(page, "readonly_admin");
  const state = fixture.bootstrap;
  state.backend_version = "v0.86.100";
  const base = state.migration_registry[0];
  if (!base || !state.user) throw new Error("Missing fixture identity");
  const ids = new Set(
    Object.entries(resourceSearchTargets)
      .filter(([kind]) => kind !== "model")
      .map(([, target]) => target.featureId),
  );
  state.migration_registry = migrationRegistry
    .filter((feature) => ids.has(feature.featureId))
    .map((feature) => ({
      ...base,
      feature_id: feature.featureId,
      title: feature.title,
      app_path: feature.appPath,
      legacy_path: feature.legacyPath,
      minimum_api_version: "v0.86.0",
      required_permission: feature.requiredPermission ?? "admin:read",
      read_only: true,
    }));
  state.allowed_features = [...ids];
  state.user.features = Object.fromEntries([...ids].map((id) => [id, true]));
  state.permissions = state.user.scopes = ["admin:read", "security:read", "observability:read"];
  const searches: { query: string; kinds: ResourceKind[] }[] = [];
  const result = { failPolicy: true, release: () => {}, holdNext: false };
  await page.route("**/admin/resource-search", async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || new URL(request.url()).search)
      throw new Error("Invalid search transport");
    const body = request.postDataJSON() as (typeof searches)[number];
    searches.push(body);
    if (result.holdNext) {
      result.holdNext = false;
      await new Promise<void>((resolve) => {
        result.release = resolve;
      });
    }
    return route.fulfill({
      json: {
        request_id: "search-workspace-fixture",
        groups: [...body.kinds].reverse().map((kind) => ({
          kind,
          status: kind === "policy" && result.failPolicy ? "unavailable" : "ok",
          limited: kind === "setting",
          items:
            kind === "policy" && result.failPolicy
              ? []
              : [
                  {
                    kind,
                    id:
                      kind === "setting"
                        ? runtimeKey
                        : kind === "provider"
                          ? `prv_${"a".repeat(43)}`
                          : `${kind}_billing`,
                    title: `${resourceSearchTargets[kind].title} 정산`,
                    ...(kind === "mcp_tool" ? { server_label: "정산 서버" } : {}),
                  },
                ],
        })),
      },
    });
  });
  return { ...fixture, searches, result };
}
