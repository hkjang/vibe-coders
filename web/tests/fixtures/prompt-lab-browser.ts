import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import { labExperiment, labCase, labContract, labReceipt } from "./prompt-lab";

export async function installPromptLab(page: Page, readOnly = false) {
  const user = {
    id: "public-lab-operator",
    name: "공개 실험 사용자",
    email: "public@example.invalid",
    role: "admin",
    roles: ["admin"],
    team_id: "public-team",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.68",
    ui_version: "public-lab-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/prompts/lab",
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
    allowed_features: ["prompts.lab"],
    migration_registry: [
      {
        feature_id: "prompts.lab",
        title: "프롬프트 실험실",
        app_path: "/app/prompts/lab",
        legacy_path: "/admin#/prompt-lab",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: readOnly,
        enabled_roles: [],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.82.0",
        available: true,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {},
  };
  const state = {
    experiments: [structuredClone(labExperiment)],
    testCase: structuredClone(labCase),
    lost: false,
    postStatus: 200,
    readStatus: 200,
    historyStatus: 200,
    history: structuredClone(labReceipt.history),
    malformedRun: false,
  };
  const writes: { method: string; path: string; body: unknown }[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method();
    if (url.pathname.startsWith("/app/")) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (url.pathname === "/auth/me") return json({ authenticated: true, user });
    if (url.pathname === "/admin/ui-bootstrap") return json(bootstrap);
    if (url.pathname === "/health") return json({ status: "ok" });
    const path = url.pathname.replace("/admin/prompt-lab/", "");
    if (method === "GET") {
      if (path === "experiments")
        return state.readStatus === 200
          ? json({ experiments: state.experiments })
          : json({ error: { message: "public error" } }, state.readStatus);
      if (path === `experiments/${labExperiment.id}`)
        return json({ experiment: state.experiments[0], test_cases: [state.testCase] });
      if (path === "contracts") return json({ contracts: [labContract] });
      if (path === "rubrics") return json({ rubrics: [] });
      if (path === `test-cases/${labCase.id}`)
        return state.historyStatus === 200
          ? json({ test_case: state.testCase, history: state.history })
          : json({ error: { message: "public history error" } }, state.historyStatus);
    }
    if (url.pathname.startsWith("/admin/prompt-lab/") && ["POST", "PATCH", "DELETE"].includes(method)) {
      writes.push({
        method,
        path,
        body: request.postData() ? (request.postDataJSON() as unknown) : undefined,
      });
      if (state.lost) return route.abort("failed");
      if (state.postStatus !== 200) return json({ error: { message: "public rejection" } }, state.postStatus);
      if (path === `test-cases/${labCase.id}/run`)
        return json({ ...labReceipt, ...(state.malformedRun ? { results: [] } : {}) });
      if (path === "experiments") return json({ ...labExperiment, id: "public-new-experiment" });
      if (path === "contracts") return json(labContract);
      if (path === "rubrics") return json({ id: "public-rubric", name: "공개 평가 기준" });
      if (path === "test-cases") return json(labCase);
      if (method === "PATCH") {
        const body = request.postDataJSON() as { status: string };
        const experiment = state.experiments.find((row) => path === `experiments/${row.id}`);
        if (experiment) {
          experiment.status = body.status;
          experiment.updated_at = "2030-01-04T00:00:00Z";
        }
        return json({ status: body.status });
      }
      if (method === "DELETE") return json({ status: "deleted" });
    }
    unexpected.push(`${method} ${url.pathname}`);
    return json({ error: { message: "unexpected public fixture request" } }, 500);
  });
  return {
    bootstrap,
    state,
    writes,
    check: () => {
      expect(unexpected).toEqual([]);
      expect(errors).toEqual([]);
    },
  };
}
