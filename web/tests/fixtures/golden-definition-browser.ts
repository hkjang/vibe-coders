import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { GoldenPrompt, GoldenWorkflow } from "../../src/shared/api/domains/golden";
import { goldenPrompts, goldenWorkflows } from "./golden-regression";

export async function installDefinitionEditor(page: Page, readOnly = false) {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, "randomUUID", { value: undefined, configurable: true });
  });
  const user = {
    id: "public-definition-editor",
    name: "공개 편집 사용자",
    email: "public@example.invalid",
    role: "admin",
    roles: ["admin"],
    team_id: "",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.66",
    ui_version: "public-editor-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/prompts/regression",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: false,
      authenticated: true,
      mode: "open",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
      credential_prefixes: ["corp_"],
    },
    user,
    roles: user.roles,
    permissions: user.scopes,
    capabilities: { raw_prompt_view: false },
    allowed_features: ["prompts.regression"],
    migration_registry: [
      {
        feature_id: "prompts.regression",
        title: "회귀 검증 세트",
        app_path: "/app/prompts/regression",
        legacy_path: "/admin#/prompt-lab",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: readOnly,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: false,
        minimum_api_version: "v0.86.66",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = {
    prompts: structuredClone(goldenPrompts),
    workflows: structuredClone(goldenWorkflows),
    lostResponse: false,
    readStatus: 200,
    postStatus: 200,
  };
  const writes: { path: string; body: Record<string, unknown> }[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url());
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    if (request.method() === "GET" && url.pathname === "/admin/golden-prompts")
      return state.readStatus === 200
        ? json({ golden_prompts: state.prompts, results: [] })
        : json({ error: { message: "public read denied" } }, state.readStatus);
    if (request.method() === "GET" && url.pathname === "/admin/golden-workflows")
      return json({ workflows: state.workflows });
    if (
      request.method() === "POST" &&
      ["/admin/golden-prompts", "/admin/golden-workflows"].includes(url.pathname)
    ) {
      const body = request.postDataJSON() as Record<string, unknown>;
      writes.push({ path: url.pathname, body });
      expect(body).not.toHaveProperty("models");
      expect(body).not.toHaveProperty("run");
      expect(body).not.toHaveProperty("created_at");
      expect(body).not.toHaveProperty("updated_at");
      if (state.postStatus !== 200) return json({ error: { message: "public rejection" } }, state.postStatus);
      const times = { created_at: "2030-01-01T00:00:00Z", updated_at: "2030-01-04T00:00:00Z" };
      if (url.pathname === "/admin/golden-prompts") {
        const saved = { ...body, ...times } as GoldenPrompt;
        state.prompts = [...state.prompts.filter((row) => row.id !== saved.id), saved];
        if (state.lostResponse) return route.abort("failed");
        return json({ golden_prompt: saved, results: [] }, 201);
      }
      const saved = { ...body, ...times } as GoldenWorkflow;
      state.workflows = [...state.workflows.filter((row) => row.id !== saved.id), saved];
      if (state.lostResponse) return route.abort("failed");
      return json(saved);
    }
    unexpected.push(`${request.method()} ${url.pathname}`);
    return json({ error: { message: "unexpected public fixture request" } }, 500);
  });
  return {
    state,
    writes,
    bootstrap,
    check: () => {
      expect(errors).toEqual([]);
      expect(unexpected).toEqual([]);
    },
  };
}
