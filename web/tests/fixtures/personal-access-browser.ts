import { expect, type Page } from "@playwright/test";
import { installPersonalConsole } from "./personal-console-browser";

export const accessSession = {
  id: "public-device",
  ip: "192.0.2.20",
  user_agent: "공개 노트북 · Chromium",
  current: false,
  sso_linked: true,
  created_at: "2030-01-02T00:00:00Z",
  expires_at: "2030-01-09T00:00:00Z",
};
export async function installPersonalAccess(page: Page, readOnly = false) {
  const base = await installPersonalConsole(page, readOnly, "v0.86.72");
  const state = {
    sessions: [
      {
        ...accessSession,
        id: "public-current",
        ip: "192.0.2.10",
        user_agent: "현재 브라우저",
        current: true,
      },
      accessSession,
    ],
    sessionsStatus: 200,
    doctorStatus: 200,
    wrong: false,
  };
  const reads: { path: string; client: string | null }[] = [];
  const writes: { path: string; body: unknown }[] = [];
  const urls = { base_url: "https://gateway.example/v1", mcp_url: "https://gateway.example/mcp/gateway" };
  await page.route("**/me/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname;
    const json = (body: unknown, status = 200) => route.fulfill({ json: body, status });
    if (request.method() === "GET") {
      if (!["/me/keys", "/me/sessions", "/me/onboarding-pack"].includes(path)) return route.fallback();
      reads.push({ path, client: url.searchParams.get("client") });
      if (path === "/me/keys")
        return json({ api_keys: [], role: "developer", grantable_scopes: ["chat:completion"] });
      if (path === "/me/sessions")
        return state.sessionsStatus === 200
          ? json({ current_session_id: "public-current", sessions: state.sessions })
          : json({ error: { message: "public fixture failure" } }, state.sessionsStatus);
      return json({
        ...urls,
        client: url.searchParams.get("client"),
        available_models: ["public-balanced", "public-fast"],
        recommended_models: ["vibe/auto"],
        scopes: ["chat:completion"],
        config: "ignored server command",
      });
    }
    if (request.method() === "POST" && path === "/me/connection-doctor") {
      const body = request.postDataJSON() as { client: string };
      writes.push({ path, body });
      if (state.doctorStatus !== 200)
        return json({ error: { message: "public fixture failure" } }, state.doctorStatus);
      return json({
        ...urls,
        client: body.client,
        overall: "warn",
        auth_mode: "jwt",
        checks: [
          { name: "authorization", status: "pass", detail: "로그인 세션을 확인했습니다." },
          {
            name: "scope",
            status: "warn",
            detail: "MCP 사용 권한을 확인하세요.",
            fix: "발급 키의 MCP 권한을 확인하세요.",
          },
          {
            name: "endpoint_reachability",
            status: "skip",
            detail: "브라우저에서는 실제 연결을 검사하지 않습니다.",
          },
        ],
      });
    }
    if (request.method() === "DELETE" && path.startsWith("/me/sessions/")) {
      const id = decodeURIComponent(path.split("/").at(-1) ?? "");
      writes.push({ path, body: null });
      if (!state.wrong) state.sessions = state.sessions.filter((row) => row.id !== id);
      return json({ status: "revoked", session_id: state.wrong ? "other-device" : id });
    }
    if (request.method() === "POST" && path === "/me/sessions/revoke-others") {
      writes.push({ path, body: null });
      const count = state.sessions.filter((row) => !row.current).length;
      state.sessions = state.sessions.filter((row) => row.current);
      return json({ status: "revoked", revoked_count: count });
    }
    return route.fallback();
  });
  return {
    state,
    reads,
    writes,
    check: () => {
      base.check();
      expect(writes.filter((w) => w.path === "/me/sessions/public-current")).toEqual([]);
    },
  };
}
