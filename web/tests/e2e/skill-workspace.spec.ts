import { expect, type Page } from "@playwright/test";
import {
  test,
  firstEmail,
  secondEmail,
  firstName,
  targetUrl,
  skill,
} from "../fixtures/skill-fitness-gateway";
import { watchEditorAssets } from "../fixtures/agent-code-editor";

async function login(page: Page, email = firstEmail) {
  await page.goto(`login?return_to=${encodeURIComponent(targetUrl)}`);
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("heading", { name: "스킬", exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
test.beforeEach(async ({ page, gateway }) => {
  expect(gateway.unexpected).toEqual([]);
  await watchEditorAssets(page);
});

test("조회 거부 후 목록을 폐기하고 수동으로 복구한다", async ({ page }) => {
  let calls = 0;
  await page.route("**/admin/skills/scan", (route) => {
    calls += 1;
    return route.fulfill({ status: 403, json: { error: { message: "fixture denied" } } });
  });
  await login(page);
  await page.getByRole("button", { name: "보안 스캔", exact: true }).click();
  await expect(page.getByText("스킬 조회 권한을 다시 확인하세요.", { exact: true })).toBeVisible();
  await expect(page.getByRole("table", { name: "스킬 카탈로그" })).toHaveCount(0);
  expect(calls).toBe(1);
  await page.getByRole("button", { name: "다시 시도", exact: true }).click();
  await expect(page.getByRole("button", { name: `${firstName} 상세 열기`, exact: true })).toBeVisible();
  expect(calls).toBe(1);
});

test("시뮬레이션 중 입력을 바꾸면 이전 판정을 숨기고 새 입력만 다시 확인한다", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const calls: unknown[] = [];
  await page.route("**/admin/skills/evaluate", async (route) => {
    calls.push(route.request().postDataJSON());
    await gate;
    await route.fulfill({ json: { allowed: true, violations: [], would_block: false, enforcement: "off" } });
  });
  try {
    await login(page);
    await page.getByRole("button", { name: `${firstName} 상세 열기`, exact: true }).click();
    const sheet = page.getByRole("dialog", { name: firstName, exact: true });
    await sheet.getByRole("button", { name: "정책 시뮬레이션", exact: true }).click();
    await sheet.getByLabel("모델", { exact: true }).fill("first-model");
    await sheet.getByRole("button", { name: "정책 확인", exact: true }).click();
    await expect.poll(() => calls.length).toBe(1);
    await sheet.getByLabel("모델", { exact: true }).fill("next-model");
    release();
    await expect(sheet.getByRole("button", { name: "정책 확인", exact: true })).toBeEnabled();
    await expect(sheet.getByText("판정", { exact: true })).toHaveCount(0);
    await sheet.getByRole("button", { name: "정책 확인", exact: true }).click();
    await expect(sheet.getByText("판정", { exact: true })).toBeVisible();
    expect(calls).toMatchObject([{ model: "first-model" }, { model: "next-model" }]);
  } finally {
    release();
  }
});

test("로그아웃 뒤 도착한 이전 계정의 번들은 새 세션에 내려받지 않는다", async ({ page, gateway }) => {
  let release!: () => void, finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const downloads: string[] = [];
  let calls = 0;
  page.on("download", (download) => downloads.push(download.suggestedFilename()));
  await page.route("**/admin/skills/export", async (route) => {
    calls += 1;
    await gate;
    try {
      await route.fulfill({ json: { version: "1", skills: [skill("이전 계정 번들")] } });
    } finally {
      finish();
    }
  });
  try {
    await login(page);
    await page.getByRole("button", { name: "내보내기", exact: true }).click();
    await expect.poll(() => calls).toBe(1);
    await page.getByLabel("사용자 메뉴").click();
    await page.getByRole("button", { name: "로그아웃", exact: true }).click();
    await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
    gateway.replaceSkills([skill("새 계정 스킬")]);
    await login(page, secondEmail);
    await expect(page.getByRole("button", { name: "새 계정 스킬 상세 열기", exact: true })).toBeVisible();
    release();
    await finished;
    await expect(page.getByText("스킬 번들을 내려받았습니다.", { exact: true })).toHaveCount(0);
    expect(downloads).toEqual([]);
    expect(calls).toBe(1);
  } finally {
    release();
  }
});

for (const supportsReference of [false, true]) {
  test(`공백 이름의 정책 검사는 ${supportsReference ? "참조로 정확히 실행한다" : "구형 서버 안내로 안전하게 차단한다"}`, async ({
    page,
    gateway,
  }) => {
    const reference = "skl_AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
    const imported = { ...skill(" exact "), ...(supportsReference ? { skill_ref: reference } : {}) };
    gateway.replaceSkills([imported]);
    await page.emulateMedia({ colorScheme: supportsReference ? "light" : "dark", reducedMotion: "reduce" });
    const errors: string[] = [];
    const calls: unknown[] = [];
    page.on("pageerror", (error) => errors.push(error.name));
    await page.route("**/admin/skills?*", async (route) => {
      if (new URL(route.request().url()).searchParams.get("view") === "detail") {
        expect(new URL(route.request().url()).searchParams.get("skill_ref")).toBe(reference);
        return route.fulfill({ json: { skill: imported } });
      }
      return route.fallback();
    });
    await page.route("**/admin/skills/evaluate", async (route) => {
      calls.push(route.request().postDataJSON());
      return route.fulfill({
        json: { allowed: true, violations: [], would_block: false, enforcement: "off" },
      });
    });
    await login(page);
    await page.setViewportSize({ width: supportsReference ? 1440 : 390, height: 900 });
    await page.getByRole("button", { name: /상세 열기$/u }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "정책 시뮬레이션", exact: true }).click();
    const submit = sheet.getByRole("button", { name: "정책 확인", exact: true });
    if (supportsReference) {
      await submit.click();
      await expect(sheet.getByText("판정", { exact: true })).toBeVisible();
      expect(calls).toEqual([{ skill_ref: reference, model: "", tools: [], team: "" }]);
    } else {
      await expect(sheet.getByText("정확한 스킬 식별자가 필요합니다.", { exact: true })).toBeVisible();
      await expect(submit).toBeDisabled();
      await submit.evaluate((button) => button.closest("form")?.requestSubmit());
      expect(calls).toEqual([]);
    }
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: /상세 열기$/u })).toBeFocused();
    expect(errors).toEqual([]);
    expect(gateway.unexpected).toEqual([]);
  });
}
