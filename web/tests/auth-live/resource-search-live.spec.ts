import { expect } from "@playwright/test";

import { login, reader, sessionIsEmpty, signIn, signOut, test } from "./live-fixture";

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
  ];
  for (const target of targets) {
    await page.keyboard.press("Control+k");
    const palette = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
    await palette.getByRole("button", { name: "자원 검색", exact: true }).click();
    const response = page.waitForResponse(
      (value) => new URL(value.url()).pathname === "/admin/resource-search",
    );
    await palette.getByRole("combobox", { name: "자원 이름 검색" }).fill("검색검증");
    const actual = await response;
    expect(actual.status()).toBe(200);
    expect(actual.request().method()).toBe("POST");
    expect(new URL(actual.url()).search).toBe("");
    expect(await actual.headerValue("cache-control")).toBe("no-store");
    await expect(palette.getByRole("option")).toHaveCount(targets.length);
    await palette.getByRole("option", { name: new RegExp(target.title) }).click();
    await expect(page.getByRole("dialog", { name: target.title, exact: true })).toBeVisible();
    const destination = new URL(page.url());
    expect(destination.pathname).toBe(target.path);
    expect(Boolean(destination.searchParams.get(target.parameter))).toBe(true);
    expect(destination.searchParams.has("q")).toBe(false);
    await page.reload();
    await expect(page.getByRole("dialog", { name: target.title, exact: true })).toBeVisible();
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
