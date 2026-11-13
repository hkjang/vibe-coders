import { expect, type Response } from "@playwright/test";

import {
  login,
  reader,
  required,
  sessionIsEmpty,
  signIn,
  signOut,
  test,
  waitForActualAccessExpiry,
} from "./live-fixture";

// No response mocking, credential artifacts, or external services. The real Go
// harness owns the database, users, metadata and all HTTP routes.
test("AUTH-LIVE-015 실제 인증·자원 검색·상세 이동과 역할별 검색 제한", async ({ page }) => {
  await login(page);
  const targets = [
    { title: "검색검증 공급자", path: "/app/gateway/providers", parameter: "provider" },
    { title: "검색검증 워크플로", path: "/app/agents/workflows", parameter: "workflow" },
    { title: "검색검증 업무 앱", path: "/app/agents/apps", parameter: "app" },
    { title: "검색검증 스킬", path: "/app/agents/skills", parameter: "skill" },
    { title: "검색검증 MCP 서버", path: "/app/mcp", parameter: "upstream" },
    { title: "검색검증 정책", path: "/app/governance/policies/detail", parameter: "policy" },
    { title: "검색검증 등록 팀", path: "/app/access/users", parameter: "registered_team" },
    { title: "검색검증 로그인 계정", path: "/app/access/users/accounts", parameter: "account_id" },
    { title: "검색검증 프롬프트 자산", path: "/app/prompts/library", parameter: "asset" },
    { title: "검색검증 프롬프트 실험", path: "/app/prompts/lab", parameter: "exp" },
    { title: "검색검증 관측 도구", path: "/app/mcp", parameter: "tool" },
  ];
  for (const target of targets) {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
    await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
    if (target === targets[0]) {
      const access = await page.evaluate(() => sessionStorage.getItem("vibe.app.auth.access") ?? "");
      await waitForActualAccessExpiry(page, access, Number(required("VIBE_AUTH_ACCESS_TTL_SECONDS")));
      expect(
        await page.evaluate(
          (previous) => sessionStorage.getItem("vibe.app.auth.access") === previous,
          access,
        ),
      ).toBe(true);
    }
    const searchStatuses: number[] = [];
    const refreshStatuses: number[] = [];
    const collect = (value: Response): void => {
      const path = new URL(value.url()).pathname;
      if (path === "/admin/resource-search") searchStatuses.push(value.status());
      if (path === "/auth/refresh") refreshStatuses.push(value.status());
    };
    page.on("response", collect);
    // The read-only POST uses the common client's single refresh. The first
    // response may legitimately be 401; assert the final response, not timing.
    // Any non-401 error still fails the 200 assertion; failed refresh times out.
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/admin/resource-search" && value.status() !== 401,
    );
    await palette.getByRole("combobox", { name: "자원 이름 검색" }).fill("검색검증");
    const actual = await response;
    page.off("response", collect);
    expect(actual.status()).toBe(200);
    if (target === targets[0]) {
      expect(searchStatuses).toEqual([401, 200]);
      expect(refreshStatuses).toEqual([200]);
    }
    expect(actual.request().method()).toBe("POST");
    expect(new URL(actual.url()).search).toBe("");
    expect(await actual.headerValue("cache-control")).toBe("no-store");
    await expect(palette.getByRole("option")).toHaveCount(targets.length);
    await palette.getByRole("option", { name: new RegExp(target.title) }).click();
    const panel =
      target.parameter === "exp"
        ? page.getByText(`실험: ${target.title}`, { exact: true })
        : target.parameter === "tool"
          ? page.getByRole("table", { name: "MCP 도구 카탈로그" })
          : page.getByRole("dialog", {
              name:
                target.parameter === "policy"
                  ? "정책 상세"
                  : target.parameter === "registered_team"
                    ? "등록 팀 상세"
                    : target.parameter === "account_id"
                      ? "로그인 계정 상세"
                      : target.title,
              exact: true,
            });
    await expect(panel).toBeVisible();
    if (target.parameter === "policy")
      await expect(panel.getByRole("heading", { name: target.title })).toBeVisible();
    if (target.parameter === "registered_team") await expect(panel).toContainText(target.title);
    if (target.parameter === "account_id") await expect(panel).toContainText(target.title);
    if (target.parameter === "tool") await expect(panel).toContainText(target.title);
    const destination = new URL(page.url());
    if (target.parameter === "account_id")
      expect(destination.searchParams.get("account_id")).toBe("browser-search-account");
    if (target.parameter === "tool") {
      expect(destination.searchParams.get("server")).toBe("browser-search-catalog");
      expect(destination.searchParams.get("tool")).toBe(target.title);
      expect(destination.searchParams.get("mcp_only")).toBe("1");
    }
    expect(destination.pathname).toBe(target.path);
    expect(Boolean(destination.searchParams.get(target.parameter))).toBe(true);
    expect(destination.searchParams.has("q")).toBe(false);
    if (target.parameter === "registered_team") expect(destination.searchParams.get("tab")).toBe("teams");
    await page.reload();
    await expect(panel).toBeVisible();
    if (target.parameter === "policy")
      await expect(panel.getByRole("heading", { name: target.title })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  await signOut(page);
  expect(await sessionIsEmpty(page)).toBe(true);
  await signIn(page, reader);
  // Read-only admins can POST this read operation, but cannot bypass preview
  // rollout by naming the provider kind directly. Return only safe booleans.
  const restricted = await page.evaluate(async () => {
    const response = await fetch("/admin/resource-search", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "검색검증", kinds: ["provider"] }),
    });
    const body: { groups?: { kind?: string; status?: string; items?: unknown[] }[] } = await response.json();
    return {
      status: response.status,
      denied:
        body.groups?.length === 1 &&
        body.groups[0]?.kind === "provider" &&
        body.groups[0]?.status === "forbidden" &&
        body.groups[0]?.items?.length === 0,
    };
  });
  expect(restricted).toEqual({ status: 200, denied: true });
  await signOut(page);
  expect(await sessionIsEmpty(page)).toBe(true);
});
