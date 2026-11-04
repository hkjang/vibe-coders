import { expect, type Page } from "@playwright/test";
import { bootstrap, first, test } from "../fixtures/workflow-ownership-gateway";

async function openSearch(page: Page) {
  await page.goto("agents/workflows");
  await expect(page.getByRole("heading", { name: "워크플로", exact: true })).toBeVisible();
  await page.keyboard.press("Control+k");
  const dialog = page.getByRole("dialog", { name: "명령 팔레트", exact: true });
  await dialog.getByRole("button", { name: "자원 검색", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "자원 이름 검색" })).toBeFocused();
  return dialog;
}

function result(status = "ok", limited = false) {
  return {
    request_id: "synthetic-search-request",
    groups: [
      {
        kind: "workflow",
        status,
        limited,
        items: status === "ok" ? [{ kind: "workflow", id: first.id, title: first.name }] : [],
      },
    ],
  };
}

test("자원 검색은 이름을 본문으로 보내고 키보드로 같은 업무 상세를 연다", async ({ page, gateway }) => {
  const requests: unknown[] = [];
  await page.route("**/admin/resource-search", async (route) => {
    expect(route.request().method()).toBe("POST");
    expect(new URL(route.request().url()).search).toBe("");
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: result() });
  });
  const dialog = await openSearch(page);
  expect(requests).toEqual([]);
  await dialog.getByRole("combobox").fill("첫 번째");
  await expect(dialog.getByRole("option", { name: new RegExp(first.name) })).toBeVisible();
  expect(requests).toEqual([{ query: "첫 번째", kinds: ["workflow"] }]);
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(new RegExp(`workflow=${first.id}`));
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("일부 검색 실패는 재시도할 수 있고 한도 안내는 정상 결과와 함께 보인다", async ({ page, gateway }) => {
  let calls = 0;
  await page.route("**/admin/resource-search", async (route) => {
    calls += 1;
    await route.fulfill({ json: result(calls === 1 ? "unavailable" : "ok", true) });
  });
  const dialog = await openSearch(page);
  await dialog.getByRole("combobox").fill("첫 번째");
  await expect(dialog.getByRole("status")).toContainText("일부 종류");
  await dialog.getByRole("button", { name: "자원 검색 다시 시도" }).click();
  await expect(dialog.getByRole("option")).toBeVisible();
  await expect(dialog.getByRole("status")).toContainText("더 구체적으로");
  expect(calls).toBe(2);
  expect(gateway.writes).toEqual([]);
});

test("검색 재조회와 실패 동안 이전 결과 이동을 차단하고 명시적 재시도로 복구한다", async ({
  page,
  gateway,
}) => {
  const state = bootstrap("writable");
  const feature = state.migration_registry?.[0];
  if (!feature || !state.user) throw new Error("missing synthetic feature");
  state.user.features = { ...state.user.features, "agents.apps": true };
  state.allowed_features = ["agents.workflows", "agents.apps"];
  state.migration_registry = [
    feature,
    {
      ...feature,
      feature_id: "agents.apps",
      title: "업무 앱",
      app_path: "/app/agents/apps",
    },
  ];
  await page.route("**/admin/ui-bootstrap", (route) => route.fulfill({ json: state }));
  let calls = 0;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/admin/resource-search", async (route) => {
    calls += 1;
    if (calls === 1) {
      return route.fulfill({
        json: {
          ...result(),
          groups: [...result().groups, { kind: "app", status: "unavailable", limited: false, items: [] }],
        },
      });
    }
    if (calls === 2) {
      await held;
      return route.fulfill({
        status: 503,
        headers: { "X-Request-ID": "search-failed-request" },
        json: {
          error: { message: "synthetic unavailable", type: "server_error", code: "search_unavailable" },
        },
      });
    }
    return route.fulfill({ json: result() });
  });
  try {
    const dialog = await openSearch(page);
    const input = dialog.getByRole("combobox");
    await input.fill("첫 번째");
    await expect(dialog.getByRole("option")).toBeVisible();
    await dialog.getByRole("button", { name: "자원 검색 다시 시도" }).click();
    await expect(dialog.getByRole("status")).toContainText("검색하고 있습니다");
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await input.press("Enter");
    await expect(dialog).toBeVisible();
    release();
    await expect(dialog.getByRole("status")).toContainText("실패했습니다");
    await expect(input).toBeFocused();
    await expect(dialog.getByRole("option")).toHaveCount(0);
    await expect(dialog.getByText("요청 ID: search-failed-request", { exact: true })).toBeVisible();
    await expect(dialog.getByText(/synthetic-search-request/)).toHaveCount(0);
    await input.press("Enter");
    await expect(page).not.toHaveURL(/workflow=/);
    await dialog.getByRole("button", { name: "자원 검색 다시 시도" }).click();
    await expect(dialog.getByRole("option")).toBeVisible();
    await expect(input).toBeFocused();
    await input.press("Enter");
    await expect(page).toHaveURL(new RegExp(`workflow=${first.id}`));
    expect(calls).toBe(3);
    expect(gateway.writes).toEqual([]);
  } finally {
    release();
  }
});

test("모바일 자원 검색은 넘침 없이 포커스와 접근성을 유지한다", async ({ page, gateway }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.route("**/admin/resource-search", (route) => route.fulfill({ json: result() }));
  const dialog = await openSearch(page);
  await dialog.getByRole("combobox").fill("첫 번째");
  await expect(dialog.getByRole("option")).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const api = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await api.run(document)).violations.map(({ id }) => id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("resource-search-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("자원 검색에서 메뉴 검색으로 돌아오면 결과와 검색어를 다시 전송하지 않는다", async ({
  page,
  gateway,
}) => {
  let calls = 0;
  await page.route("**/admin/resource-search", async (route) => {
    calls += 1;
    await route.fulfill({ json: result() });
  });
  const dialog = await openSearch(page);
  await dialog.getByRole("combobox").fill("첫 번째");
  await expect(dialog.getByRole("option")).toBeVisible();
  await dialog.getByRole("button", { name: "메뉴·명령" }).click();
  await expect(dialog.getByRole("combobox", { name: "메뉴 검색" })).toHaveValue("");
  await dialog.getByRole("button", { name: "자원 검색", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "자원 이름 검색" })).toHaveValue("");
  expect(calls).toBe(1);
  expect(gateway.writes).toEqual([]);
});

test("한글 조합 중 Escape는 자원 검색창을 닫지 않는다", async ({ page, gateway }) => {
  const dialog = await openSearch(page);
  const input = dialog.getByRole("combobox");
  await input.dispatchEvent("compositionstart", { data: "ㅎ" });
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await input.dispatchEvent("compositionend", { data: "한" });
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(gateway.writes).toEqual([]);
});

test("높이가 짧은 화면에서도 검색 결과와 재시도에 키보드로 접근한다", async ({ page, gateway }, info) => {
  await page.setViewportSize({ width: 390, height: 390 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  let calls = 0;
  await page.route("**/admin/resource-search", (route) =>
    route.fulfill({
      json: result(++calls === 1 ? "unavailable" : "ok"),
    }),
  );
  const dialog = await openSearch(page);
  await dialog.getByRole("combobox").fill("첫 번째");
  await expect(dialog.getByRole("status")).toContainText("일부 종류");
  const bounds = await dialog.boundingBox();
  expect(Boolean(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 390)).toBe(true);
  await page.keyboard.press("Tab");
  const retry = dialog.getByRole("button", { name: "자원 검색 다시 시도" });
  await expect(retry).toBeFocused();
  await expect(retry).toBeInViewport();
  await page.keyboard.press("Enter");
  await expect(dialog.getByRole("option")).toBeInViewport();
  await page.screenshot({ path: info.outputPath("resource-search-short.png") });
  expect(gateway.writes).toEqual([]);
});
