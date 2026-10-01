import { expect, type Page } from "@playwright/test";
import { test, account, policy } from "./fixtures/policy-editor";

// Synthetic transport exercises the real React router, session and editor.
// Persistence, full-rule replacement and audit use separate actual-Go tests.
const panel = (page: Page) => page.getByRole("dialog", { name: "비활성 정책 편집", exact: true });
const trigger = (page: Page) => page.getByRole("button", { name: `${policy.name} 초안 편집`, exact: true });
const review = (page: Page) => panel(page).getByRole("button", { name: "변경 내용 검토", exact: true });
const save = (page: Page) => panel(page).getByRole("button", { name: "검토한 내용 저장", exact: true });
const success = "비활성 정책을 저장했습니다.";
const renamed = "검토한 공개 정책";
const originalRules = (policy.rules ?? []).map(({ id, name, enabled, priority, conditions, actions }) => ({
  id,
  name,
  enabled,
  priority,
  conditions,
  actions,
}));
const renamedBody = {
  id: policy.id,
  name: renamed,
  description: policy.description,
  enabled: false,
  priority: policy.priority,
  rollout_percent: policy.rollout_percent,
  rules: originalRules,
};
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgovernance%2Fpolicies%3Ftab%3Dsafety");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("button", { name: / 초안 편집$/u }).first()).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function rename(page: Page) {
  await trigger(page).click();
  await panel(page).getByLabel("정책 이름", { exact: true }).fill(renamed);
  await review(page).click();
  await expect(save(page)).toBeEnabled();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}

test("이름 변경 전후를 확인하고 복수 규칙·ID·미지의 중첩값을 그대로 저장한다", async ({ page, gateway }) => {
  await login(page);
  await rename(page);
  await expect(panel(page)).toContainText(policy.name ?? "");
  await expect(panel(page)).toContainText(renamed);
  expect(gateway.saves).toEqual([]);
  const before = gateway.reads();
  await save(page).click();
  await expect(panel(page).getByText(success, { exact: true })).toBeVisible();
  expect(gateway.saves).toEqual([renamedBody]);
  await expect.poll(() => gateway.reads()).toBeGreaterThanOrEqual(before + 2);
  await panel(page).getByRole("button", { name: "닫기", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(page.getByRole("button", { name: `${renamed} 초안 편집`, exact: true })).toBeFocused();
});

test("기존 규칙 하나만 바꾸고 새 규칙을 추가해도 보존 대상 규칙은 그대로 유지한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await trigger(page).click();
  const first = panel(page).getByRole("group", { name: "규칙 1", exact: true });
  await first.getByLabel("조건 JSON", { exact: true }).fill('{"model":"변경 모델","contains_secret":true}');
  await panel(page).getByRole("button", { name: "규칙 추가", exact: true }).click();
  const third = panel(page).getByRole("group", { name: "규칙 3", exact: true });
  await third.getByLabel("규칙 이름", { exact: true }).fill("새 공개 규칙");
  await third.getByLabel("규칙 우선순위", { exact: true }).fill("-5");
  await third.getByLabel("조건 JSON", { exact: true }).fill('{"team":"새 팀"}');
  await third.getByLabel("동작 JSON", { exact: true }).fill('{"secret_action":"mask"}');
  await review(page).click();
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([
    {
      ...renamedBody,
      name: policy.name,
      rules: [
        { ...originalRules[0], conditions: { model: "변경 모델", contains_secret: true } },
        originalRules[1],
        {
          name: "새 공개 규칙",
          enabled: true,
          priority: -5,
          conditions: { team: "새 팀" },
          actions: { secret_action: "mask" },
        },
      ],
    },
  ]);
});

test("규칙 삭제는 별도 확인을 거치며 다른 규칙과 비활성 상태를 보존한다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  const first = panel(page).getByRole("group", { name: "규칙 1", exact: true });
  await first.getByRole("button", { name: "규칙 삭제", exact: true }).click();
  expect(gateway.saves).toEqual([]);
  await first.getByRole("button", { name: "삭제 취소", exact: true }).click();
  await expect(first.getByLabel("규칙 이름", { exact: true })).toHaveValue(originalRules[0]?.name ?? "");
  await first.getByRole("button", { name: "규칙 삭제", exact: true }).click();
  await first.getByRole("button", { name: "삭제 확인", exact: true }).click();
  await review(page).click();
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([{ ...renamedBody, name: policy.name, rules: [originalRules[1]] }]);
});

test("변경 없는 편집창은 저장 요청을 만들지 않고 Escape 초점을 복원한다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  await review(page).click();
  await expect(panel(page)).toContainText("변경된 내용이 없습니다.");
  expect(gateway.saves).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
});

for (const mode of ["flag", "status"] as const) {
  test(`${mode} 읽기 전용에서는 원본을 읽되 편집 진입과 저장을 막는다`, async ({ page, gateway }) => {
    gateway.readonly(mode);
    await login(page);
    await expect(trigger(page)).toBeDisabled();
    await trigger(page).evaluate((node) => {
      (node as HTMLButtonElement).disabled = false;
      (node as HTMLButtonElement).click();
    });
    await expect(panel(page)).toBeHidden();
    expect(gateway.saves).toEqual([]);
  });
}

for (const change of ["changed", "active", "missing"] as const) {
  test(`저장 직전 ${change} 원본을 다시 읽으면 검토 초안을 보존하고 덮어쓰지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await rename(page);
    gateway.policies(
      change === "missing"
        ? []
        : [
            {
              ...policy,
              ...(change === "active" ? { enabled: true } : { description: "다른 관리자가 변경한 원본" }),
            },
          ],
    );
    const before = gateway.reads();
    await save(page).click();
    await expect.poll(() => gateway.reads()).toBeGreaterThan(before);
    await expect(panel(page).getByText("저장 전 원본을 확인하지 못했습니다.", { exact: true })).toBeVisible();
    await expect(panel(page)).toContainText(renamed);
    expect(gateway.saves).toEqual([]);
  });
}

test("저장 전 읽기 중 변경 권한이 회수되면 이미 검토한 요청도 보내지 않는다", async ({ page, gateway }) => {
  await login(page);
  await rename(page);
  const next = gateway.reads() + 1;
  gateway.holdRead(next);
  await save(page).click();
  await expect.poll(() => gateway.reads()).toBe(next);
  gateway.writable(false);
  await runtime(page);
  gateway.releaseRead(next);
  await expect(panel(page).getByText("현재 정책을 저장할 수 없습니다.", { exact: true })).toBeVisible();
  // Wait for the held preflight to settle, not just the earlier readonly notice.
  await expect(panel(page).getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  expect(gateway.saves).toEqual([]);
});

test("한 번의 저장 중 재클릭과 닫기를 잠그고 요청을 하나만 보낸다", async ({ page, gateway }) => {
  gateway.holdSave(1);
  await login(page);
  await rename(page);
  await save(page).evaluate((node) => {
    (node as HTMLButtonElement).click();
    (node as HTMLButtonElement).click();
  });
  await expect.poll(() => gateway.saves.length).toBe(1);
  await page.keyboard.press("Escape");
  await expect(panel(page)).toBeVisible();
  await panel(page).getByRole("button", { name: "대화상자 닫기", exact: true }).click();
  await expect(panel(page)).toBeVisible();
  expect(gateway.saves).toEqual([renamedBody]);
  gateway.releaseSave(1);
  await expect(panel(page)).toContainText(success);
});

test("내용이 빠진 성공 응답은 저장 완료나 자동 재전송으로 바꾸지 않는다", async ({ page, gateway }) => {
  gateway.reply(1, { status: 201, body: {}, commit: true });
  await login(page);
  await rename(page);
  await save(page).click();
  await expect(panel(page).getByText("저장 여부를 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(panel(page).getByText(success, { exact: true })).toBeHidden();
  expect(gateway.saves).toEqual([renamedBody]);
  await expect(save(page)).toBeDisabled();
  await panel(page).getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(save(page)).toBeDisabled();
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(gateway.saves).toEqual([renamedBody]);
});

test("미확정 저장은 명시적인 원본 재조회 전 재클릭·다시 검토를 잠근다", async ({ page, gateway }) => {
  gateway.reply(1, { status: 201, body: {}, commit: false });
  await login(page);
  await rename(page);
  await save(page).click();
  await expect(panel(page).getByText("저장 여부를 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  const before = gateway.reads();
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  await panel(page).getByRole("button", { name: "다시 편집", exact: true }).click();
  await review(page).click();
  await expect(save(page)).toBeDisabled();
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(gateway.reads()).toBe(before);
  expect(gateway.saves).toEqual([renamedBody]);
  await panel(page).getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(gateway.saves).toEqual([renamedBody]);
  await save(page).click();
  await expect(panel(page).getByText(success, { exact: true })).toBeVisible();
  expect(gateway.saves).toEqual([renamedBody, renamedBody]);
});

test("미확정 저장 뒤 재조회 실패는 잠금을 풀지 않고 성공한 동일 원본 조회만 재시도를 허용한다", async ({
  page,
  gateway,
}) => {
  gateway.reply(1, { status: 503, body: { error: { message: "public save unavailable" } }, commit: false });
  await login(page);
  await rename(page);
  await save(page).click();
  await expect(panel(page).getByText("저장 여부를 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await expect(save(page)).toBeDisabled();
  gateway.failFollowupReads(true);
  await panel(page).getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(panel(page).getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  await expect(save(page)).toBeDisabled();
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(gateway.saves).toEqual([renamedBody]);
  gateway.failFollowupReads(false);
  await panel(page).getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(gateway.saves).toEqual([renamedBody]);
});

test("같은 계정의 조회 권한 회수 중 미확정 응답도 복구 후 잠금·안내를 유지한다", async ({
  page,
  gateway,
}) => {
  gateway.holdSave(1);
  gateway.reply(1, { status: 201, body: {}, commit: false });
  await login(page);
  await rename(page);
  await save(page).click();
  await expect.poll(() => gateway.saves.length).toBe(1);
  gateway.readable(false);
  await runtime(page);
  await expect(panel(page).getByText("현재 정책을 저장할 수 없습니다.", { exact: true })).toBeVisible();
  gateway.releaseSave(1);
  await expect.poll(() => gateway.finished).toEqual([1]);
  await expect(panel(page).getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  gateway.readable(true);
  await runtime(page);
  await expect(panel(page).getByText("저장 여부를 확인할 수 없습니다.", { exact: true })).toBeVisible();
  await panel(page).getByRole("button", { name: "다시 편집", exact: true }).click();
  await review(page).click();
  await expect(save(page)).toBeDisabled();
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(gateway.saves).toEqual([renamedBody]);
  await panel(page).getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect(save(page)).toBeEnabled();
  expect(gateway.saves).toEqual([renamedBody]);
});

test("확정 저장 뒤 목록 실패는 저장 실패로 바꾸거나 다시 저장하지 않는다", async ({ page, gateway }) => {
  await login(page);
  await rename(page);
  gateway.failFollowupReads(true);
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  await expect(
    panel(page).getByText("저장은 완료했지만 목록을 갱신하지 못했습니다.", { exact: true }),
  ).toBeVisible();
  expect(gateway.saves).toEqual([renamedBody]);
});

test("미저장 편집은 취소를 확인하고 계속 편집한 값은 그대로 보존한다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  await panel(page).getByLabel("정책 이름", { exact: true }).fill(renamed);
  await page.keyboard.press("Escape");
  const guard = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다", exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(panel(page).getByLabel("정책 이름", { exact: true })).toHaveValue(renamed);
  await page.keyboard.press("Escape");
  await guard.getByRole("button", { name: "변경 버리기", exact: true }).click();
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.saves).toEqual([]);
});

test("기존 민감 JSON은 DOM에 노출하지 않고 이름만 변경해도 원문을 유지한다", async ({ page, gateway }) => {
  const marker = `corp_${"s".repeat(40)}`;
  const protectedConditions = { model: marker, unknown: { password: "public-synthetic-password" } };
  gateway.policies([
    {
      ...policy,
      rules: (policy.rules ?? []).map((rule, index) =>
        index === 0 ? { ...rule, conditions: protectedConditions } : rule,
      ),
    },
  ]);
  await login(page);
  await rename(page);
  await expect(panel(page)).toContainText("민감정보");
  expect(await page.locator("body").textContent()).not.toContain(marker);
  expect(
    await page
      .locator("input, textarea")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value).join("\n")),
  ).not.toContain(marker);
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([
    { ...renamedBody, rules: [{ ...originalRules[0], conditions: protectedConditions }, originalRules[1]] },
  ]);
  expect(page.url()).not.toContain(marker);
  expect(
    await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])),
  ).not.toContain(marker);
});

test("보호된 JSON 전체 교체는 빈 입력에서 시작하고 마스킹 문구를 저장하지 않는다", async ({
  page,
  gateway,
}) => {
  const marker = `corp_${"r".repeat(40)}`;
  gateway.policies([
    {
      ...policy,
      rules: (policy.rules ?? []).map((rule, index) =>
        index === 0 ? { ...rule, conditions: { model: marker } } : rule,
      ),
    },
  ]);
  await login(page);
  await trigger(page).click();
  const first = panel(page).getByRole("group", { name: "규칙 1", exact: true });
  await first.getByRole("button", { name: "조건 JSON 전체 교체", exact: true }).click();
  await expect(first.getByLabel("조건 JSON", { exact: true })).toHaveValue("");
  await first.getByLabel("조건 JSON", { exact: true }).fill('{"model":"교체 모델"}');
  await review(page).click();
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([
    {
      ...renamedBody,
      name: policy.name,
      rules: [{ ...originalRules[0], conditions: { model: "교체 모델" } }, originalRules[1]],
    },
  ]);
  expect(JSON.stringify(gateway.saves)).not.toContain(marker);
  expect(JSON.stringify(gateway.saves)).not.toContain("민감정보");
});

test("새 민감값과 잘못된 JSON은 검토·저장 전에 입력 가까이에서 차단한다", async ({ page, gateway }) => {
  await login(page);
  await trigger(page).click();
  const field = panel(page)
    .getByRole("group", { name: "규칙 1", exact: true })
    .getByLabel("조건 JSON", { exact: true });
  await field.fill('{"model":');
  await review(page).click();
  await expect(panel(page)).toContainText("올바른 JSON 객체");
  await expect(field).toBeFocused();
  await field.fill(JSON.stringify({ model: `corp_${"n".repeat(40)}` }));
  await review(page).click();
  await expect(panel(page)).toContainText("새 민감정보");
  expect(gateway.saves).toEqual([]);
});

test("전송 후 변경 권한이 회수되어도 정상 저장 확인을 잃거나 재전송하지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.holdSave(1);
  await login(page);
  await rename(page);
  await save(page).click();
  await expect.poll(() => gateway.saves.length).toBe(1);
  gateway.writable(false);
  await runtime(page);
  gateway.releaseSave(1);
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([renamedBody]);
});

test("모든 규칙 삭제는 확인을 요구하며 실제 omitempty 응답 뒤에도 다시 편집한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await trigger(page).click();
  for (const index of [1, 2]) {
    const rule = panel(page).getByRole("group", { name: `규칙 ${index}`, exact: true });
    await rule.getByRole("button", { name: "규칙 삭제", exact: true }).click();
    await rule.getByRole("button", { name: "삭제 확인", exact: true }).click();
  }
  await review(page).click();
  await expect(panel(page)).toContainText("규칙을 모두 비우는 변경을 명시적으로 확인하세요.");
  expect(gateway.saves).toEqual([]);
  await panel(page).getByLabel("모든 규칙을 비우는 변경을 확인했습니다", { exact: true }).check();
  await review(page).click();
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([{ ...renamedBody, name: policy.name, rules: [] }]);
  await panel(page).getByRole("button", { name: "닫기", exact: true }).click();
  await rename(page);
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([
    { ...renamedBody, name: policy.name, rules: [] },
    { ...renamedBody, rules: [] },
  ]);
});

test("표시 보호 접두사가 바뀌면 이미 열린 비교도 즉시 가리고 재검토 전 저장하지 않는다", async ({
  page,
  gateway,
}) => {
  const marker = `later_${"x".repeat(40)}`;
  gateway.policies([
    {
      ...policy,
      rules: (policy.rules ?? []).map((rule, index) =>
        index === 0 ? { ...rule, conditions: { model: marker } } : rule,
      ),
    },
  ]);
  await login(page);
  await rename(page);
  await expect(panel(page)).toContainText(marker);
  gateway.prefixes(["corp_", "later_"]);
  await runtime(page);
  await expect(save(page)).toBeDisabled();
  expect(await page.locator("body").textContent()).not.toContain(marker);
  await save(page).evaluate((node) => (node as HTMLButtonElement).click());
  expect(gateway.saves).toEqual([]);
  await panel(page).getByRole("button", { name: "다시 편집", exact: true }).click();
  expect(
    await page
      .locator("input, textarea")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLInputElement).value).join("\n")),
  ).not.toContain(marker);
  await review(page).click();
  await save(page).click();
  await expect(panel(page)).toContainText(success);
  expect(gateway.saves).toEqual([
    { ...renamedBody, rules: [{ ...originalRules[0], conditions: { model: marker } }, originalRules[1]] },
  ]);
});

test("소유자 A에서 B로 바뀐 뒤 다시 A가 되어도 이전 편집을 되살리지 않는다", async ({ page, gateway }) => {
  await login(page);
  await rename(page);
  gateway.owner("public-policy-editor-b");
  await runtime(page);
  await expect(panel(page)).toBeHidden();
  gateway.owner(account.id);
  await runtime(page);
  await expect(panel(page)).toBeHidden();
  await trigger(page).click();
  await expect(panel(page).getByLabel("정책 이름", { exact: true })).toHaveValue(policy.name ?? "");
  expect(gateway.saves).toEqual([]);
});

test("390px 다크 편집·비교에서 키보드 스크롤·폐기 확인·초점·axe를 지킨다", async ({
  page,
  gateway,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await trigger(page).focus();
  await page.keyboard.press("Enter");
  await panel(page).getByLabel("정책 이름", { exact: true }).fill(renamed);
  await review(page).click();
  await expect(panel(page).getByRole("heading", { name: "변경 내용 검토", exact: true })).toBeFocused();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await panel(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const before = await panel(page).evaluate((node) => node.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => panel(page).evaluate((node) => node.scrollTop)).toBeGreaterThan(before);
  expect(
    await page.evaluate(async () => {
      const engine = (
        window as Window & { axe?: { run: (root: Document) => Promise<{ violations: { id: string }[] }> } }
      ).axe;
      if (!engine) throw new Error("Accessibility engine missing");
      return (await engine.run(document)).violations.map((item) => item.id);
    }),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("policy-editor-review-mobile-dark.png") });
  await page.keyboard.press("Escape");
  const guard = page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다", exact: true });
  await expect(guard.getByRole("button", { name: "계속 편집", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(guard.getByRole("button", { name: "변경 버리기", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel(page)).toBeHidden();
  await expect(trigger(page)).toBeFocused();
  expect(gateway.saves).toEqual([]);
});
