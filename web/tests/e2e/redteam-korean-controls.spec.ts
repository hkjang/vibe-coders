import { expect, test, type Page } from "@playwright/test";
import type { AxeResults } from "axe-core";
import { installPromptLibrary } from "../fixtures/prompt-library-browser";

async function fixture(page: Page, custom: false | "vendor" | "prototype" = false) {
  const base = await installPromptLibrary(page);
  base.bootstrap.backend_version = "v0.86.142";
  base.bootstrap.allowed_features = ["security.redteam"];
  const feature = base.bootstrap.migration_registry[0];
  if (!feature) throw Error("missing fixture feature");
  Object.assign(feature, {
    feature_id: "security.redteam",
    title: "레드팀 자동화",
    app_path: "/app/redteam",
    legacy_path: "/admin#/redteam",
    required_permission: "admin:read",
    risk_level: "critical",
  });
  const probe = {
    id: "public-case",
    pack_id: "public-pack",
    case_key: "public_probe",
    input_template: "공개 합성 검사 입력",
    expected_policy: custom === "prototype" ? "__proto__" : custom ? "vendor_policy" : "refuse",
    evaluator_type: custom === "prototype" ? "constructor" : custom ? "vendor_eval" : "rule",
    severity: custom === "prototype" ? "__proto__" : custom ? "vendor_risk" : "high",
    target_types:
      custom === "prototype" ? ["__proto__", "model"] : custom ? ["vendor_type", "model"] : ["model"],
    parameters: {},
    risk_tags: [],
  };
  const pack = {
    id: "public-pack",
    name: "공개 검사 묶음",
    category: "prompt_injection",
    severity: "high",
    version: "v1",
    enabled: true,
    requires_approval: true,
    cases: [probe],
  };
  const writes: unknown[] = [];
  await page.route("**/admin/redteam/**", async (route) => {
    const request = route.request(),
      path = new URL(request.url()).pathname;
    if (request.method() === "GET") {
      if (path === "/admin/redteam/probe-packs") return route.fulfill({ json: { probe_packs: [pack] } });
      if (path === "/admin/redteam/targets")
        return route.fulfill({
          json: {
            targets: [
              {
                id: "public-target",
                target_type: "model",
                target_ref: "model:public",
                model: "public-model",
                provider: "public-provider",
                risk_level: "high",
                enabled: true,
                metadata: {},
              },
            ],
          },
        });
      return route.fulfill({ json: path.endsWith("kill-switch") ? { enabled: false } : {} });
    }
    expect(path).toBe("/admin/redteam/probe-cases");
    expect(request.method()).toBe("POST");
    const body: unknown = request.postDataJSON();
    writes.push(body);
    return route.fulfill({ json: { case: probe, pack_id: pack.id } });
  });
  return { ...base, writes };
}

async function open(page: Page) {
  await page.goto("redteam?tab=targets");
  await page.getByRole("button", { name: "공개 검사 묶음 검사 보기", exact: true }).click();
  await page.getByRole("button", { name: "public_probe 편집", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "프롬프트 편집", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("한글 조건과 대상 선택은 기존 API 값으로 저장하고 새로고침해도 대상 탭을 유지한다", async ({ page }) => {
  const api = await fixture(page);
  const panel = await open(page);
  await panel.getByLabel("기대 정책", { exact: true }).selectOption({ label: "요청 차단" });
  await panel.getByLabel("평가 방식", { exact: true }).selectOption({ label: "도구 호출 검사" });
  await panel.getByLabel("심각도", { exact: true }).selectOption({ label: "보통" });
  await panel.getByRole("checkbox", { name: "MCP 도구", exact: true }).check();
  await expect(panel.getByText("선택한 2개 유형에만 적용합니다.")).toBeVisible();
  await panel.getByRole("button", { name: "저장", exact: true }).click();
  await expect(panel).toBeHidden();
  expect(api.writes).toEqual([
    {
      case_id: "public-case",
      pack_id: "public-pack",
      case_key: "public_probe",
      input_template: "공개 합성 검사 입력",
      expected_policy: "block",
      evaluator_type: "tool_call",
      severity: "medium",
      target_types: ["model", "mcp_tool"],
    },
  ]);
  await page.reload();
  await expect(page.getByRole("tab", { name: "대상·검사 묶음", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  api.check();
});

for (const custom of ["vendor", "prototype"] as const)
  test(`${custom}: 사용자 정의 값은 알려진 유형 선택 뒤에도 보존한다`, async ({ page }) => {
    const api = await fixture(page, custom);
    const panel = await open(page);
    await expect(panel.getByLabel("기대 정책", { exact: true })).toHaveValue(
      custom === "prototype" ? "__proto__" : "vendor_policy",
    );
    await expect(panel.getByLabel("평가 방식", { exact: true })).toHaveValue(
      custom === "prototype" ? "constructor" : "vendor_eval",
    );
    await expect(panel.getByLabel("심각도", { exact: true })).toHaveValue(
      custom === "prototype" ? "__proto__" : "vendor_risk",
    );
    await panel.getByRole("checkbox", { name: "제공자", exact: true }).check();
    await panel.getByRole("button", { name: "저장", exact: true }).click();
    await expect(panel).toBeHidden();
    expect(api.writes).toEqual([
      expect.objectContaining({
        expected_policy: custom === "prototype" ? "__proto__" : "vendor_policy",
        evaluator_type: custom === "prototype" ? "constructor" : "vendor_eval",
        severity: custom === "prototype" ? "__proto__" : "vendor_risk",
        target_types: [custom === "prototype" ? "__proto__" : "vendor_type", "model", "provider"],
      }),
    ]);
    api.check();
  });

for (const theme of ["light", "dark"] as const)
  for (const width of [1440, 390])
    test(`${theme} ${width}px 한글 검사 편집의 시각·키보드·접근성`, async ({ page }) => {
      const api = await fixture(page);
      await page.setViewportSize({ width, height: 1100 });
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
      const panel = await open(page);
      await expect(panel.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
      await expect(panel.getByRole("button", { name: "취소", exact: true })).toBeInViewport();
      await expect(panel).toHaveScreenshot(`redteam-korean-controls-${theme}-${width}.png`, {
        animations: "disabled",
      });
      const checkbox = panel.getByRole("checkbox", { name: "모델", exact: true });
      await checkbox.focus();
      await checkbox.press("Space");
      await expect(panel.getByText("선택 없음 — 모든 대상 유형에 적용합니다.")).toBeVisible();
      await checkbox.press("Space");
      await expect(panel.getByRole("button", { name: "저장", exact: true })).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const violations = await page.evaluate(
        async () =>
          (
            await (window as unknown as { axe: { run: (root: Document) => Promise<AxeResults> } }).axe.run(
              document,
            )
          ).violations,
      );
      expect(violations).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(page.getByRole("button", { name: "public_probe 편집", exact: true })).toBeFocused();
      const remove = page.getByRole("button", { name: "public_probe 삭제", exact: true });
      await remove.click();
      await page
        .getByRole("dialog", { name: "프롬프트 삭제", exact: true })
        .getByRole("button", { name: "취소", exact: true })
        .click();
      await expect(remove).toBeFocused();
      expect(api.writes).toEqual([]);
      api.check();
    });
