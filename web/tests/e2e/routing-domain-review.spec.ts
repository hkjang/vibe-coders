import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  reviewUrl,
  reviewPath,
  reviewID,
  encodedReviewID,
  reviewRow,
  rawQueryMarker,
} from "./fixtures/routing-domain-review";

const dialogFor = (page: Page) => page.getByRole("dialog", { name: "도메인 검토 상태 기록", exact: true });
const finalFor = (dialog: Locator, action: "approve" | "reject" = "approve") =>
  dialog.getByRole("button", {
    name: action === "approve" ? "승인 상태 기록" : "거절 상태 기록",
    exact: true,
  });
const consentFor = (dialog: Locator) =>
  dialog.getByRole("checkbox", {
    name: "이 작업은 검토 상태만 기록함을 확인했습니다",
    exact: true,
  });
const refreshFor = (dialog: Locator) =>
  dialog.getByRole("button", { name: "검토 목록 다시 조회", exact: true });
const queueFor = (page: Page) => page.getByRole("table", { name: "도메인 라우팅 검토 큐", exact: true });

test("조회 403은 열린 검토를 폐기하고 후속 503에서도 이전 내용이나 전송 동의를 복원하지 않는다", async ({
  page,
  reviewer,
}) => {
  await login(page);
  const { dialog } = await open(page);
  await consent(dialog);
  const oldConfirm = await finalFor(dialog).elementHandle();
  reviewer.setStatus("list", 403);
  await refreshFor(dialog).click();
  await expect(dialog).toHaveCount(0);
  await expect(queueFor(page)).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText(reviewRow.reason);
  await expect(page.getByText("서버가 조회를 허용하지 않아", { exact: false })).toBeVisible();
  await expect(page.getByText("도메인 라우팅 검토 큐", { exact: true })).toBeFocused();
  await oldConfirm?.evaluate((button) => (button as HTMLButtonElement).click());
  expect(reviewer.posts()).toEqual([]);

  reviewer.setStatus("list", 503);
  await page.getByRole("button", { name: "검토 목록 다시 조회", exact: true }).click();
  await expect(page.getByText("최신 검토 목록을 확인하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(page.locator("body")).not.toContainText(reviewRow.reason);
  await expect(dialog).toHaveCount(0);
  expect(reviewer.posts()).toEqual([]);

  reviewer.setStatus("list", 200);
  reviewer.setRows([{ ...reviewRow, id: "new-review-after-denial", reason: "새로 허용된 합성 검토" }]);
  await page.getByRole("button", { name: "검토 목록 다시 조회", exact: true }).click();
  await expect(queueFor(page)).toContainText("새로 허용된 합성 검토");
  await expect(page.locator("body")).not.toContainText(reviewRow.reason);
  await expect(dialog).toHaveCount(0);
  const fresh = await open(page);
  await expect(consentFor(fresh.dialog)).not.toBeChecked();
  await expect(finalFor(fresh.dialog)).toBeDisabled();
  expect(reviewer.posts()).toEqual([]);
});

async function login(page: Page, target = reviewUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(target)}`);
  await page.getByLabel("이메일", { exact: true }).fill(firstEmail);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "검토 상태", exact: true })).toBeVisible();
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function open(page: Page, action: "approve" | "reject" = "approve") {
  const trigger = queueFor(page).getByRole("button", {
    name: action === "approve" ? /검토 승인$/u : /검토 거절$/u,
  });
  await trigger.click();
  const dialog = dialogFor(page);
  await expect(dialog.getByRole("heading", { name: "기록할 상태 검토", exact: true })).toBeVisible();
  return { dialog, trigger };
}
async function consent(dialog: Locator, action: "approve" | "reject" = "approve") {
  await consentFor(dialog).check();
  await expect(finalFor(dialog, action)).toBeEnabled();
}
async function refreshIdentity(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("상태만 기록하는 한계와 동의를 읽고 현재 status 및 limit만 조회한다", async ({ page, reviewer }) => {
  await login(page, `${reviewUrl}?window=30d&route=public-route`);
  const { dialog } = await open(page);
  await expect(dialog).toContainText("상태와 검토 시각만 기록합니다");
  await expect(dialog).toContainText("학습 예시로 승격하거나 라우팅 규칙을 바꾸지 않습니다");
  await expect(dialog).toContainText("다른 검토자가 먼저 변경했는지 확인하지 않습니다");
  await expect(dialog).toContainText("성공 응답만으로 항목의 존재나 실제 변경");
  await expect(dialog).toContainText(reviewID.trim());
  await expect(page.locator("body")).not.toContainText(rawQueryMarker);
  expect(reviewer.reads().at(-1)?.query).toEqual({ status: "pending", limit: "50" });
  await expect(consentFor(dialog)).not.toBeChecked();
  await expect(finalFor(dialog)).toBeDisabled();
  await finalFor(dialog).dispatchEvent("click");
  expect(reviewer.posts()).toEqual([]);
  await consent(dialog);
  expect(reviewer.posts()).toEqual([]);
});

for (const action of ["approve", "reject"] as const) {
  test(`${action}는 선택한 원문 ID를 인코딩한 body 없는 POST 한 번으로 기록한다`, async ({
    page,
    reviewer,
  }) => {
    await login(page);
    const { dialog } = await open(page, action);
    await consent(dialog, action);
    reviewer.hold("decide");
    await finalFor(dialog, action).click();
    await expect.poll(() => reviewer.posts().length).toBe(1);
    expect(reviewer.posts()).toEqual([
      {
        method: "POST",
        path: `${reviewPath}/${encodedReviewID}%2F${action}`,
        body: null,
        query: {},
      },
    ]);
    await expect(finalFor(dialog, action)).toBeDisabled();
    await finalFor(dialog, action).dispatchEvent("click");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeVisible();
    expect(reviewer.posts()).toHaveLength(1);
    reviewer.release("decide");
    await expect(dialog).toContainText("검토 상태 기록 요청을 확인했습니다.");
    await expect(
      dialog.getByRole("region", { name: "도메인 검토 상태 기록 결과", exact: true }),
    ).toBeFocused();
    await expect(refreshFor(dialog)).toHaveAttribute("aria-busy", "false");
    expect(reviewer.records()).toEqual([
      {
        ...reviewRow,
        status: action === "approve" ? "approved" : "rejected",
        reviewed_at: "2026-10-08T01:00:00Z",
      },
    ]);
    await dialog.getByRole("button", { name: "닫기", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "검토 상태", exact: true })
      .selectOption(action === "approve" ? "approved" : "rejected");
    await expect(queueFor(page).getByRole("button", { name: /검토 승인$/u })).toBeDisabled();
    await expect(queueFor(page).getByRole("button", { name: /검토 거절$/u })).toBeDisabled();
    expect(reviewer.posts()).toHaveLength(1);
  });
}

for (const mode of ["write_revoked", "read_only", "preview_read_only", "raw_revoked"] as const) {
  test(`동의 뒤 ${mode} 변경은 기존 검토를 종료하고 POST 하지 않는다`, async ({
    page,
    reviewer,
    gateway,
  }) => {
    await login(page);
    const { dialog } = await open(page);
    await consent(dialog);
    const originalConfirm = await finalFor(dialog).elementHandle();
    expect(originalConfirm).not.toBeNull();
    if (mode === "write_revoked") gateway.setWrite(false);
    else if (mode === "raw_revoked") gateway.setRawPromptView(false);
    else gateway.setMode(mode);
    await refreshIdentity(page);
    await expect(dialog).toHaveCount(0);
    await originalConfirm?.evaluate((button) => (button as HTMLButtonElement).click());
    if (mode === "raw_revoked") {
      await expect(page.getByText("도메인 검토 조회 권한을 확인하세요.", { exact: true })).toBeVisible();
      await expect(queueFor(page)).toHaveCount(0);
    } else {
      await expect(queueFor(page).getByRole("button", { name: /검토 승인$/u })).toBeDisabled();
    }
    expect(reviewer.posts()).toEqual([]);
    gateway.setMode("writable");
    gateway.setWrite(true);
    gateway.setRawPromptView(true);
    await refreshIdentity(page);
    const fresh = await open(page);
    await expect(consentFor(fresh.dialog)).not.toBeChecked();
    await expect(finalFor(fresh.dialog)).toBeDisabled();
    expect(reviewer.posts()).toEqual([]);
  });
}

test("프롬프트 원문 조회 capability가 없으면 검토 GET과 POST를 시작하지 않는다", async ({
  page,
  reviewer,
  gateway,
}) => {
  gateway.setRawPromptView(false);
  await login(page);
  await expect(page.getByText("도메인 검토 조회 권한을 확인하세요.", { exact: true })).toBeVisible();
  expect(reviewer.reads()).toEqual([]);
  expect(reviewer.posts()).toEqual([]);
  await expect(queueFor(page)).toHaveCount(0);
});

for (const [name, ack] of [
  ["missing fields", {}],
  ["other ID", { id: "other-review", status: "approved" }],
  ["opposite action", { id: reviewID, status: "rejected" }],
  ["unknown status", { id: reviewID, status: "future-status" }],
] as const) {
  test(`불확실한 ACK (${name}) 뒤 원래 목록을 다시 조회해도 같은 창은 재전송하지 않는다`, async ({
    page,
    reviewer,
  }) => {
    await login(page);
    const { dialog } = await open(page);
    await consent(dialog);
    reviewer.ack(ack);
    await finalFor(dialog).click();
    await expect(dialog).toContainText("검토 상태 기록 여부를 확인하지 못했습니다.");
    await expect(dialog).not.toContainText("검토 상태 기록 요청을 확인했습니다.");
    expect(reviewer.posts()).toHaveLength(1);
    // A later identical pending row cannot prove the preceding POST failed.
    reviewer.setRows([{ ...reviewRow }]);
    const before = reviewer.reads().length;
    await refreshFor(dialog).click();
    await expect.poll(() => reviewer.reads().length).toBeGreaterThan(before);
    await expect(refreshFor(dialog)).toHaveAttribute("aria-busy", "false");
    await expect(dialog).toContainText("검토 목록 조회를 완료했습니다.");
    await expect(finalFor(dialog)).toBeDisabled();
    await expect(consentFor(dialog)).toBeDisabled();
    await finalFor(dialog).dispatchEvent("click");
    await dialog.getByRole("button", { name: "기록할 상태 다시 검토", exact: true }).dispatchEvent("click");
    expect(reviewer.posts()).toHaveLength(1);
  });
}

test("정확한 ACK 뒤 GET 실패는 구분해서 표시하고 GET만 복구한다", async ({ page, reviewer }) => {
  await login(page);
  const { dialog } = await open(page);
  await consent(dialog);
  reviewer.failFollowingRead();
  await finalFor(dialog).click();
  await expect(dialog).toContainText("검토 상태 기록 요청을 확인했습니다.");
  await expect(dialog).toContainText("기록 응답은 확인했지만 목록을 다시 조회하지 못했습니다.");
  await expect(dialog).toContainText("상태 기록을 반복하지 않고 목록 조회만 다시 시도할 수 있습니다.");
  await expect(finalFor(dialog)).toHaveCount(0);
  expect(reviewer.posts()).toHaveLength(1);
  const before = reviewer.reads().length;
  reviewer.setStatus("list", 200);
  await refreshFor(dialog).click();
  await expect.poll(() => reviewer.reads().length).toBeGreaterThan(before);
  await expect(refreshFor(dialog)).toHaveAttribute("aria-busy", "false");
  await expect(dialog).not.toContainText("기록 응답은 확인했지만 목록을 다시 조회하지 못했습니다.");
  await expect(dialog).toContainText("검토 상태 기록 요청을 확인했습니다.");
  expect(reviewer.posts()).toHaveLength(1);
});

test("390px 다크 검토창은 키보드 동의와 포커스 복귀, 넘침 및 axe 검사를 통과한다", async ({
  page,
  reviewer,
}, testInfo) => {
  reviewer.setRows([{ ...reviewRow, reason: "긴 공개 합성 검토 사유입니다. ".repeat(12) }]);
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  const { dialog, trigger } = await open(page);
  await expect(dialog.getByRole("heading", { name: "기록할 상태 검토", exact: true })).toBeFocused();
  await page.screenshot({
    path: testInfo.outputPath("routing-domain-review-mobile-dark-initial.png"),
    fullPage: true,
  });
  await page.keyboard.press("Tab");
  await expect(consentFor(dialog)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(consentFor(dialog)).toBeChecked();
  const final = finalFor(dialog);
  await expect(final).toBeInViewport({ ratio: 1 });
  expect(
    await final.evaluate((element) => {
      const box = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await expect(page.locator("body")).not.toContainText(rawQueryMarker);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  const violations = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Element, options: object) => Promise<{ violations: { id: string }[] }> };
      }
    ).axe;
    const dialog = document.querySelector('[role="dialog"]');
    if (!dialog) throw new Error("도메인 검토창이 없습니다.");
    return (
      await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"] },
      })
    ).violations;
  });
  expect(violations).toEqual([]);
  await page.screenshot({
    path: testInfo.outputPath("routing-domain-review-mobile-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Space");
  await expect(consentFor(dialog)).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(reviewer.posts()).toEqual([]);
});
