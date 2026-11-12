import { expect, type Page } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { PromptAsset, PromptAssetHistoryEntry, SavedFilter } from "../../src/shared/api/domains/prompts";

export const libraryAsset: PromptAsset = {
  id: "public-summary",
  name: "업무 요약",
  category: "custom",
  description: "공개 예제 문서의 핵심과 다음 행동을 정리합니다.",
  body: "문서의 핵심을 세 문장으로 요약하세요.\n사실과 의견을 구분하고 다음 행동을 제안하세요.",
  tags: ["요약", "업무"],
  status: "draft",
  enabled: true,
  note: "공개 검증 자료",
  use_count: 12,
  created_at: "2030-01-01T00:00:00Z",
  updated_at: "2030-01-02T00:00:00Z",
  call_count: 28,
  success_rate: 0.96,
  avg_cost_krw: 24.5,
  avg_latency_ms: 840,
};
export const libraryHistory: PromptAssetHistoryEntry[] = [
  {
    id: "public-history-2",
    template_id: libraryAsset.id,
    action: "edit",
    version_num: 2,
    name: libraryAsset.name,
    category: "custom",
    description: libraryAsset.description,
    body: libraryAsset.body,
    tags: libraryAsset.tags,
    has_snapshot: true,
    actor: "공개 운영자",
    created_at: "2030-01-02T00:00:00Z",
  },
  {
    id: "public-history-1",
    template_id: libraryAsset.id,
    action: "create",
    version_num: 1,
    name: libraryAsset.name,
    category: "custom",
    description: "초기 공개 설명",
    body: "문서를 짧게 요약하세요.",
    tags: ["요약"],
    has_snapshot: true,
    actor: "공개 운영자",
    created_at: "2030-01-01T00:00:00Z",
  },
];
export async function installPromptLibrary(page: Page, readOnly = false) {
  const user = {
    id: "public-library-operator",
    name: "공개 보관함 사용자",
    email: "public@example.invalid",
    role: "admin",
    roles: ["admin"],
    team_id: "public-team",
    scopes: ["admin:read", "admin:write"],
  };
  const bootstrap: UiBootstrapResponse = {
    backend_version: "v0.86.69",
    ui_version: "public-library-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/prompts/library",
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
    allowed_features: ["prompts.library"],
    migration_registry: [
      {
        feature_id: "prompts.library",
        title: "프롬프트 라이브러리",
        app_path: "/app/prompts/library",
        legacy_path: "/admin#/prompts",
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
    assets: [structuredClone(libraryAsset)],
    history: structuredClone(libraryHistory),
    filters: [] as SavedFilter[],
    readStatus: 200,
    historyStatus: 200,
    lost: false,
    wrongReceipt: false,
  };
  const writes: { method: string; path: string; body: unknown }[] = [],
    unexpected: string[] = [],
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.name));
  await page.route("**/*", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      method = request.method(),
      path = url.pathname;
    if (path.startsWith("/app/")) return route.continue();
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (path === "/auth/me") return json({ authenticated: true, user });
    if (path === "/admin/ui-bootstrap") return json(bootstrap);
    if (path === "/health") return json({ status: "ok" });
    if (method === "GET") {
      if (path === "/admin/prompt-assets") {
        if (state.readStatus !== 200) return json({ error: { message: "public error" } }, state.readStatus);
        const keyword = url.searchParams.get("q") ?? "",
          status = url.searchParams.get("status");
        return json({
          assets: state.assets.filter(
            (row) =>
              (!keyword || row.name?.includes(keyword) || row.description?.includes(keyword)) &&
              (!status || row.status === status),
          ),
          categories: [{ key: "custom", label: "기타" }],
          known_tags: [{ key: "요약", label: "요약" }],
          stats: {
            draft: state.assets.filter((row) => row.status === "draft").length,
            pending: state.assets.filter((row) => row.status === "pending").length,
            approved: 0,
            standard: 0,
          },
        });
      }
      if (path.endsWith("/history"))
        return state.historyStatus === 200
          ? json({ history: state.history })
          : json({ error: { message: "public history error" } }, state.historyStatus);
      if (path.endsWith("/usage"))
        return json({
          usage: [
            { team: "플랫폼", calls: 24, errors: 1, cost_krw: 280 },
            { team: "제품", calls: 4, errors: 0, cost_krw: 35 },
          ],
        });
      if (path === "/admin/prompts")
        return json({
          requests: [
            {
              id: "public-request-1",
              created_at: "2030-01-02T00:00:00Z",
              model: "public-model",
              status_code: 200,
              latency_ms: 840,
              total_tokens: 1200,
              estimated_cost: 24.5,
              prompts: [{ role: "user", redacted_text: "공개 문서를 요약해 주세요." }],
            },
          ],
        });
      if (path === "/admin/prompts/fingerprints")
        return json({
          fingerprints: [
            {
              fingerprint: "public-fingerprint",
              task_type: "요약",
              requests: 28,
              success_rate: 0.96,
              avg_cost_krw: 24.5,
              top_model: "public-model",
              cheapest_model: "public-small",
              sample_prompt: "공개 문서를 요약해 주세요.",
            },
          ],
        });
      if (path === "/admin/prompts/debt")
        return json({
          count: 1,
          total_debt_cost_krw: 1300,
          items: [
            {
              fingerprint: "public-debt",
              debt_score: 72,
              debt_type: "model_waste",
              task_type: "요약",
              sample_prompt: "공개 문서 요약",
              requests: 40,
              success_rate: 95,
              total_cost_krw: 1300,
              top_model: "public-model",
              cheaper_model: "public-small",
              action: "소형 모델 비교",
              last_seen: "2030-01-02T00:00:00Z",
            },
          ],
        });
      if (path === "/admin/saved-filters") return json({ filters: state.filters });
      if (path === "/admin/export.csv")
        return route.fulfill({
          contentType: "text/csv",
          body: "\uFEFFcreated_at,trace_id,request_id,endpoint,provider,model,api_key_id,client_ip,status_code,first_chunk_ms,latency_ms,prompt_tokens,completion_tokens,cached_tokens,reasoning_tokens,total_tokens,cost_krw,token_source,stream,languages,error\n2030-01-02T00:00:00Z,public-trace,public-request,/v1/chat/completions,public-provider,public-model,public-key,127.0.0.1,200,12,840,800,400,0,0,1200,24.50,upstream,false,,\n",
        });
    }
    if (path.startsWith("/admin/") && ["POST", "PATCH", "DELETE"].includes(method)) {
      const body = request.postData() ? (request.postDataJSON() as Record<string, unknown>) : undefined;
      writes.push({ method, path, body });
      if (state.lost) return route.abort("failed");
      if (path === "/admin/templates" && body) {
        const created = { ...libraryAsset, ...body } as PromptAsset;
        state.assets.push(created);
        return json({ template: created });
      }
      if (path === "/admin/saved-filters" && body) {
        const filter = { id: "public-filter", ...body } as SavedFilter;
        state.filters.push(filter);
        return json({ filter });
      }
      const id = path.split("/")[3] ?? "",
        current = state.assets.find((row) => row.id === id);
      if (path.startsWith("/admin/saved-filters/") && method === "DELETE") {
        state.filters = state.filters.filter((row) => row.id !== id);
        return json({ id, status: "deleted" });
      }
      if (current) {
        if (method === "PATCH") {
          Object.assign(current, body);
          return json({ template: { ...current, id: state.wrongReceipt ? "wrong-public-id" : id } });
        }
        if (method === "DELETE") {
          state.assets = state.assets.filter((row) => row.id !== id);
          return json({ id, status: "deleted" });
        }
        if (path.endsWith("/submit")) {
          current.status = "pending";
          return json({ id, status: "pending" });
        }
        if (path.endsWith("/approve")) {
          current.status = String(body?.status);
          return json({ id, status: current.status });
        }
        if (path.endsWith("/use")) return json(current);
        if (path.endsWith("/rollback")) {
          const snapshot = state.history.find((row) => row.version_num === body?.version);
          if (!snapshot) return json({ error: { message: "public missing snapshot" } }, 404);
          const { name, category, description, body: content, tags } = snapshot;
          Object.assign(current, { name, category, description, body: content, tags });
          state.history.unshift({
            ...snapshot,
            id: "public-history-3",
            action: "rollback",
            version_num: 3,
            created_at: "2030-01-03T00:00:00Z",
          });
          return json({ template: current, restored_from: snapshot.version_num });
        }
      }
    }
    unexpected.push(`${method} ${path}`);
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
