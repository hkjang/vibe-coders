import { expect, test, type Page } from "@playwright/test";
import { installOverviewActivity } from "../fixtures/overview-activity-browser";

async function holdOverviewReads(page: Page) {
  let holding = true,
    active = 0,
    peak = 0;
  const started: string[] = [];
  const pending: Array<() => void> = [];
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (!request.headers()["x-vibe-route"]?.startsWith("overview.")) return route.fallback();
    expect(request.method()).toBe("GET");
    started.push(new URL(request.url()).pathname);
    if (holding) {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => pending.push(resolve));
      active--;
    }
    await route.fallback();
  });
  return {
    started,
    active: () => active,
    peak: () => peak,
    releaseOne: () => {
      const next = pending.shift();
      if (!next) throw new Error("No pending overview read");
      next();
    },
    releaseAll: () => {
      holding = false;
      pending.splice(0).forEach((release) => release());
    },
  };
}

test("느린 운영 개요 API는 최대 4개씩 진행하고 하나가 끝나면 다음 영역을 조회한다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  const reads = await holdOverviewReads(page);
  try {
    await page.goto("overview");
    await expect.poll(() => reads.active()).toBe(4);
    await expect(page.getByRole("heading", { name: "주의 신호와 최근 작업", exact: true })).toBeVisible();
    await page.evaluate(
      () => new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
    );
    expect(reads.started).toHaveLength(4);
    reads.releaseOne();
    await expect.poll(() => reads.started.length).toBe(5);
    expect(reads.active()).toBe(4);
    expect(reads.peak()).toBe(4);
    reads.releaseAll();
    await expect(page.getByRole("button", { name: "전체 새로고침", exact: true })).toBeEnabled();
    await expect(page.getByText("₩4,200")).toBeVisible();
    expect(fixture.activity.reads.map(({ path }) => path).sort()).toEqual([
      "/admin/alerts/summary",
      "/admin/audit-logs/summary",
      "/admin/incidents/summary",
    ]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    reads.releaseAll();
  }
});

test("화면 이동은 아직 시작하지 않은 운영 개요 조회를 취소하고 새 화면을 정상 조회한다", async ({ page }) => {
  const fixture = await installOverviewActivity(page);
  const reads = await holdOverviewReads(page);
  try {
    await page.goto("overview");
    await expect.poll(() => reads.active()).toBe(4);
    const initial = [...reads.started];
    const retired = [
      "/admin/stats",
      "/admin/ops/risk",
      "/admin/routing/health",
      "/admin/incidents/summary",
      "/admin/alerts/summary",
      "/admin/audit-logs/summary",
    ].filter((path) => !initial.includes(path));
    expect(retired.length).toBeGreaterThan(0);
    const settingsRead = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/admin/settings/effective",
    );
    await page
      .getByRole("complementary", { name: "주 메뉴" })
      .getByRole("link", { name: "시스템 설정", exact: true })
      .click();
    await expect(page).toHaveURL(/system\/settings/u);
    expect((await settingsRead).status()).toBe(200);
    reads.releaseAll();
    await expect(page.getByRole("heading", { name: "시스템 설정", exact: true })).toBeVisible();
    for (const path of retired) expect(reads.started).not.toContain(path);
    expect(reads.started).toEqual(initial);
    expect(fixture.writes).toEqual([]);
    expect(fixture.unexpected).toEqual([]);
  } finally {
    reads.releaseAll();
  }
});
