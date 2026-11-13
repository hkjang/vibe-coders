import { expect, type Page } from "@playwright/test";
import { bootstrap, first, second, test } from "../fixtures/workflow-ownership-gateway";

async function open(page: Page) {
  await page.goto("agents/workflows");
  await page.getByRole("button", { name: `${first.name} 상세 열기`, exact: true }).click();
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode}: 변경 버튼을 막고 읽기 전용 모의 검사만 보낸다`, async ({ page, gateway }) => {
    gateway.setMode(mode);
    await open(page);
    const detail = page.getByRole("dialog", { name: first.name, exact: true });
    for (const name of ["게시", "수정", "삭제"])
      await expect(detail.getByRole("button", { name, exact: true })).toBeDisabled();
    await detail.getByRole("button", { name: "드라이런", exact: true }).click();
    await expect(detail.getByRole("heading", { name: "드라이런 결과", exact: true })).toBeVisible();
    expect(gateway.simulations).toEqual([first.id]);
    expect(gateway.writes).toEqual([]);
  });
}

test("열린 게시창을 읽기 전용 전환 후 키보드로 제출할 수 없다", async ({ page, gateway }) => {
  await open(page);
  await page.getByRole("button", { name: "게시", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크플로 게시", exact: true });
  await dialog.getByLabel(/^변경 사유/).fill("합성 게시 검토");
  gateway.setMode("read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "게시", exact: true })).toBeDisabled();
  await page.keyboard.press("Enter");
  expect(gateway.writes).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("모바일 편집 초안을 보존하고 읽기 전용 전환 뒤 직접 제출도 거부한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await open(page);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크플로 수정", exact: true });
  await dialog.getByLabel(/^이름/).fill("보존할 합성 초안");
  gateway.setMode("preview_read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
  await expect(dialog.getByLabel(/^이름/)).toHaveValue("보존할 합성 초안");
  await dialog.locator("form").evaluate((form) => (form as HTMLFormElement).requestSubmit());
  expect(gateway.writes).toEqual([]);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const violations = await page.evaluate(async () => {
    const api = (
      window as unknown as { axe: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
    ).axe;
    return (await api.run(document)).violations.map(({ id }) => id);
  });
  expect(violations).toEqual([]);
  await page.screenshot({ path: info.outputPath("workflow-readonly-mobile.png"), fullPage: true });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" })).toBeVisible();
  await page.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(dialog.getByLabel(/^이름/)).toHaveValue("보존할 합성 초안");
});

test("입력 전 Shift+Tab으로 선택한 저장 버튼의 포커스를 읽기 전용 전환 뒤 복구한다", async ({
  page,
  gateway,
}) => {
  await open(page);
  await page.getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "워크플로 수정", exact: true });
  await expect(dialog.getByRole("button", { name: "대화상자 닫기", exact: true })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeFocused();
  gateway.setMode("read_only");
  await runtime(page);
  await expect(dialog.getByRole("button", { name: "수정 저장", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeFocused();
  expect(gateway.writes).toEqual([]);
});

test("늦은 모의 검사 결과가 다른 업무 상세에 섞이지 않는다", async ({ page, gateway }) => {
  gateway.holdSimulation();
  await open(page);
  await page.getByRole("button", { name: "드라이런", exact: true }).click();
  await expect.poll(() => gateway.simulations.length).toBe(1);
  const canceled = page.waitForEvent(
    "requestfailed",
    (request) => new URL(request.url()).pathname === "/admin/workflows/wf_first/dry-run",
  );
  await page.keyboard.press("Escape");
  expect((await canceled).failure()?.errorText).toContain("ERR_ABORTED");
  await page.getByRole("button", { name: `${second.name} 상세 열기`, exact: true }).click();
  const detail = page.getByRole("dialog", { name: second.name, exact: true });
  await expect(detail).toBeVisible();
  gateway.releaseSimulation();
  await detail.getByRole("button", { name: "드라이런", exact: true }).click();
  await expect(detail.getByText("두 번째 업무 검사 근거", { exact: true })).toBeVisible();
  await expect(detail.getByText("첫 번째 업무 검사 근거", { exact: true })).toHaveCount(0);
  expect(gateway.simulations).toEqual([first.id, second.id]);
  expect(gateway.writes).toEqual([]);
});

test("팀이 바뀌면 버전 이력을 다시 읽고 이전 메모를 제거한다", async ({ page, gateway }) => {
  let team = "first-team";
  let reads = 0;
  await page.route("**/admin/ui-bootstrap", (route) => {
    const value = bootstrap("writable");
    if (!value.user) throw new Error("합성 사용자 누락");
    value.user = { ...value.user, team_id: team };
    return route.fulfill({ json: value });
  });
  await page.route("**/admin/workflows/wf_first/versions", (route) => {
    reads++;
    return route.fulfill({
      json: {
        workflow_id: first.id,
        versions: [
          {
            id: "version-one",
            version: 1,
            note: team === "first-team" ? "이전 팀 게시 메모" : "새 팀 게시 메모",
          },
        ],
      },
    });
  });
  await open(page);
  await page.getByRole("button", { name: "버전 이력", exact: true }).click();
  await expect(page.getByText("이전 팀 게시 메모", { exact: true })).toBeVisible();
  team = "second-team";
  await runtime(page);
  await expect(page.getByText("이전 팀 게시 메모", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "버전 이력", exact: true }).click();
  await expect(page.getByText("새 팀 게시 메모", { exact: true })).toBeVisible();
  expect(reads).toBe(2);
  expect(gateway.writes).toEqual([]);
});

test("버전 조회 권한이 거부되면 닫고 수동 재조회 후 이력을 다시 연다", async ({ page, gateway }) => {
  let reads = 0;
  await page.route("**/admin/workflows/wf_first/versions", (route) => {
    reads++;
    return reads === 1
      ? route.fulfill({ status: 403, json: { error: { message: "권한 없음" } } })
      : route.fulfill({
          json: {
            workflow_id: first.id,
            versions: [{ id: "version-one", version: 1, note: "복구한 게시 메모" }],
          },
        });
  });
  await open(page);
  await page.getByRole("button", { name: "버전 이력", exact: true }).click();
  await expect(page.getByText(/워크플로 조회 권한이 없거나 인증 상태가 변경되었습니다/)).toBeVisible();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(reads).toBe(1);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("dialog", { name: first.name, exact: true })).toBeVisible();
  expect(reads).toBe(1);
  await page.getByRole("button", { name: "버전 이력", exact: true }).click();
  await expect(page.getByText("복구한 게시 메모", { exact: true })).toBeVisible();
  expect(reads).toBe(2);
  expect(gateway.writes).toEqual([]);
});
