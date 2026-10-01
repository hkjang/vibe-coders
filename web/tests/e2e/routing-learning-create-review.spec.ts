import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  learningUrl,
  learningModel,
  learningPath,
  listPath,
  reportFor,
} from "./fixtures/routing-learning-create";

const dialogFor = (page: Page) =>
  page.getByRole("dialog", { name: "학습 추천으로 규칙 만들기", exact: true });
const finalFor = (dialog: Locator) => dialog.getByRole("button", { name: "규칙 만들기", exact: true });
const impactFor = (dialog: Locator) =>
  dialog.getByRole("checkbox", {
    name: "작업 유형과 관계없이 해당 복잡도 범위에 적용됨을 확인했습니다",
    exact: true,
  });
const expectedInput = (bucket: string, min: number, max: number, model = learningModel) => ({
  match_pattern: "*",
  target_model: model,
  target_provider: "",
  min_complexity: min,
  max_complexity: max,
  priority: 100,
  note: `학습 추천 적용 (code/${bucket})`,
  enabled: true,
});

async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(learningUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("table", { name: "학습된 모델 추천", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page) {
  const trigger = page.getByRole("button", { name: /추천을 규칙으로 적용/u });
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("heading", { name: "생성 내용 검토", exact: true })).toBeVisible();
  return { dialog, trigger };
}
async function approve(dialog: Locator) {
  await impactFor(dialog).check();
  await expect(finalFor(dialog)).toBeEnabled();
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("추천과 실제 조건을 구분해 읽고 작업 유형 비제한에 동의하기 전에는 전송하지 않는다", async ({
  page,
  learner,
  creator,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await expect(dialog).toContainText(learningModel);
  await expect(dialog).toContainText("code");
  await expect(dialog).toContainText("사용 중");
  await expect(finalFor(dialog)).toBeDisabled();
  expect(learner.calls.some((call) => call.path === learningPath && call.window === "7d")).toBe(true);
  expect(creator.calls).toEqual([]);
  await approve(dialog);
  expect(creator.calls).toEqual([]);
});

for (const [bucket, min, max] of [
  ["low", 0, 33],
  ["medium", 34, 66],
  ["high", 67, 100],
] as const) {
  test(`${bucket} 추천을 서버 구간 ${min}–${max}에 맞춘 8개 값으로 한 번만 생성한다`, async ({
    page,
    learner,
    creator,
    gateway,
  }) => {
    learner.setReport(reportFor(bucket));
    await login(page);
    const { dialog, trigger } = await open(page);
    await approve(dialog);
    creator.hold();
    await finalFor(dialog).click();
    await expect.poll(() => creator.calls.length).toBe(1);
    expect(creator.calls).toEqual([
      { method: "POST", path: listPath, body: expectedInput(bucket, min, max) },
    ]);
    await expect(finalFor(dialog)).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    creator.release();
    await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
    expect(gateway.records().at(-1)).toEqual({
      ...expectedInput(bucket, min, max),
      id: "route_created_1",
      created_at: "2026-10-02T00:00:00Z",
    });
    expect(gateway.operations.filter((call) => call.action === "patch")).toEqual([]);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(trigger).toBeFocused();
  });
}

test("알 수 없는 추천 구간을 전체 0–100 규칙으로 확대하지 않는다", async ({ page, learner, creator }) => {
  learner.setReport(reportFor("future"));
  await login(page);
  await expect(
    page.getByText("알 수 없는 복잡도 구간으로는 규칙을 만들 수 없습니다.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: /추천을 규칙으로 적용/u })).toBeDisabled();
  expect(creator.calls).toEqual([]);
});

test("추천의 NEL은 Go처럼 정리하고 FEFF 모델 식별자는 보존한다", async ({ page, learner, creator }) => {
  learner.setReport(reportFor("low", "\u0085\ufeffpublic-model\ufeff\u0085"));
  await login(page);
  const { dialog } = await open(page);
  await approve(dialog);
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  expect(creator.calls).toEqual([
    { method: "POST", path: listPath, body: expectedInput("low", 0, 33, "\ufeffpublic-model\ufeff") },
  ]);
});

for (const mode of ["write_revoked", "read_only", "preview_read_only"] as const) {
  test(`열린 추천 검토의 ${mode} 변경 후에는 POST 하지 않는다`, async ({
    page,
    learner,
    creator,
    gateway,
  }) => {
    expect(learner.calls).toEqual([]);
    await login(page);
    const { dialog } = await open(page);
    await approve(dialog);
    if (mode === "write_revoked") gateway.setWrite(false);
    else gateway.setMode(mode);
    await refreshIdentity(page);
    await expect(finalFor(dialog)).toBeDisabled();
    await expect(dialog).toContainText(learningModel);
    expect(creator.calls).toEqual([]);
  });
}

test("불명확한 생성 응답은 수동 규칙 조회 뒤에도 같은 창에서 다시 전송하지 않는다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  expect(learner.calls).toEqual([]);
  await login(page);
  const { dialog } = await open(page);
  await approve(dialog);
  creator.ack({});
  await finalFor(dialog).click();
  await expect(dialog).toContainText("생성 여부를 확인하지 못했습니다.");
  expect(gateway.records()).toHaveLength(3);
  const before = gateway.count("list");
  const refresh = dialog.getByRole("button", { name: "목록 다시 조회", exact: true });
  await refresh.click();
  await expect.poll(() => gateway.count("list")).toBeGreaterThan(before);
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(finalFor(dialog)).toBeDisabled();
  expect(creator.calls).toHaveLength(1);
});

test("확인된 생성과 후속 목록 실패를 구분하고 조회만 복구한다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  expect(learner.calls).toEqual([]);
  await login(page);
  const { dialog } = await open(page);
  await approve(dialog);
  creator.failFollowingRead();
  await finalFor(dialog).click();
  await expect(dialog).toContainText("라우팅 규칙 생성 요청을 확인했습니다.");
  await expect(dialog).toContainText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  gateway.setStatus("list", 200);
  const refresh = dialog.getByRole("button", { name: "목록 다시 조회", exact: true });
  await refresh.click();
  await expect(refresh).toHaveAttribute("aria-busy", "false");
  await expect(dialog).not.toContainText("생성 요청은 확인했지만 목록을 다시 조회하지 못했습니다.");
  expect(creator.calls).toHaveLength(1);
});

test("관측 최다 모델과 같은 추천을 저장된 규칙이 이미 있다는 뜻으로 표시하지 않는다", async ({
  page,
  learner,
  creator,
}) => {
  const report = reportFor();
  report.cells = report.cells.filter((cell) => cell.model === learningModel);
  report.recommendations = report.recommendations.map((row) => ({
    ...row,
    differs: false,
    top_model: row.recommended_model,
    top_success_rate: row.success_rate,
    confident: true,
  }));
  learner.setReport(report);
  await login(page);
  await expect(page.getByText("관측 최다 모델과 동일", { exact: true })).toBeVisible();
  await expect(page.getByText("이미 사용 중", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /추천을 규칙으로 적용/u })).toHaveCount(0);
  expect(creator.calls).toEqual([]);
});

test("현재 표시 보호 기준의 민감 모델은 숨기고 마스킹 문자열로 생성하지 않는다", async ({
  page,
  learner,
  creator,
  gateway,
}) => {
  const marker = "custom_private_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";
  learner.setReport(reportFor("low", marker));
  gateway.setPrefixes(["vc_sk_", "vc_sa_", "custom_private_"]);
  await login(page);
  await expect(page.locator("body")).not.toContainText(marker);
  await expect(page.getByRole("button", { name: /추천을 규칙으로 적용/u })).toBeDisabled();
  expect(creator.calls).toEqual([]);
});

test("390px 다크 화면에서 한글 검토와 동의를 키보드로 읽고 실행 버튼을 가리지 않는다", async ({
  page,
  learner,
  creator,
}, testInfo) => {
  expect(learner.calls).toEqual([]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog } = await open(page);
  await expect(dialog.getByRole("heading", { name: "생성 내용 검토", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(impactFor(dialog)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(impactFor(dialog)).toBeChecked();
  const button = finalFor(dialog);
  await expect(button).toBeInViewport({ ratio: 1 });
  expect(
    await button.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return element.contains(
        document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
      );
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Element, options: object) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("학습 추천 검토창이 없습니다.");
    return (
      await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("routing-learning-review-mobile-dark.png"),
    fullPage: true,
  });
  expect(creator.calls).toEqual([]);
});
