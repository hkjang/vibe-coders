import { expect, type Locator, type Page } from "@playwright/test";
import { admin, login, reader, test } from "./live-fixture";

const routingPath = "/app/routing/rules/preview";
const policyPath = "/app/governance/policies/advisor";
const previewEndpoint = "/admin/routing/preview";
const simulationEndpoint = "/admin/policies/simulate";
const costSuggestion = "모델 browser-cost-model 비용 급증 — 승인 요구";

function value(root: Locator, label: string) {
  return root
    .locator(".kv-item")
    .filter({ has: root.page().getByText(label, { exact: true }) })
    .locator("dd");
}
function postResponse(page: Page, path: string) {
  return page.waitForResponse(
    (response) => response.request().method() === "POST" && new URL(response.url()).pathname === path,
  );
}
async function simulate(page: Page, title: string) {
  const response = postResponse(page, simulationEndpoint);
  await page.getByRole("button", { name: `${title} 섀도우 영향 확인`, exact: true }).click();
  expect((await response).status()).toBe(200);
  const dialog = page.getByRole("dialog", { name: "섀도우 영향 분석", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("SIMULATION-LIVE-001 실제 규칙의 선택 모델과 변경된 입력 안내", async ({ page }) => {
  let calls = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === previewEndpoint) calls++;
  });
  await login(page, admin, routingPath);
  const card = page.locator(".routing-preview-card");
  await card.getByRole("textbox", { name: "요청 모델", exact: true }).fill("browser-order-request");
  await card.getByLabel("샘플 요청 내용").fill("테스트 요청입니다.");
  const response = postResponse(page, previewEndpoint);
  await card.getByRole("button", { name: "미리보기 실행", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(value(card, "선택 모델")).toHaveText("browser-order-a");
  await expect(value(card, "선택 공급자")).toHaveText("test");
  await expect(card).toContainText("요청 모델을 바꾸는 계획입니다.");
  await card.getByRole("textbox", { name: "요청 모델", exact: true }).fill("browser-other-model");
  await expect(card).toContainText("입력이 달라졌습니다. 다시 미리보기로 확인하세요.");
  await expect(value(card, "선택 모델")).toHaveText("browser-order-a");
  expect(calls).toBe(1);
  expect(new URL(page.url()).search).not.toContain("테스트");
});

test("SIMULATION-LIVE-002 없는 키 정책 오류를 표시하고 수정 후 명시적으로 다시 실행", async ({ page }) => {
  await login(page, admin, routingPath);
  const card = page.locator(".routing-preview-card");
  await card.getByRole("textbox", { name: "요청 모델", exact: true }).fill("browser-order-request");
  await card.getByLabel("정책 API 키 ID", { exact: true }).fill("missing-policy-key");
  const failed = postResponse(page, previewEndpoint);
  await card.getByRole("button", { name: "미리보기 실행", exact: true }).click();
  expect((await failed).status()).toBe(404);
  await expect(card).toContainText("미리보기를 실행하지 못했습니다.");
  await expect(value(card, "선택 모델")).toHaveCount(0);
  await card.getByLabel("정책 API 키 ID", { exact: true }).clear();
  const retry = postResponse(page, previewEndpoint);
  await card.getByRole("button", { name: "미리보기 실행", exact: true }).click();
  expect((await retry).status()).toBe(200);
  await expect(value(card, "선택 모델")).toHaveText("browser-order-a");
});

test("SIMULATION-LIVE-003 실제 비용 추천과 기간별 승인 예상 집계", async ({ page }) => {
  await login(page, admin, policyPath);
  let dialog = await simulate(page, costSuggestion);
  await expect(value(dialog, "평가 표본 수")).toHaveText("8");
  await expect(value(dialog, "승인 요구 예상")).toHaveText("7");
  await expect(value(dialog, "허용 예상")).toHaveText("1");
  await expect(value(dialog, "차단 예상")).toHaveText("0");
  await expect(dialog).toContainText("정책을 저장하거나 적용하지 않습니다.");
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: `${costSuggestion} 섀도우 영향 확인`, exact: true }),
  ).toBeFocused();
  await page.getByLabel("정책 어드바이저 분석 기간").selectOption("24h");
  dialog = await simulate(page, costSuggestion);
  await expect(value(dialog, "실행한 분석 기간")).toHaveText("최근 24시간");
  await expect(value(dialog, "평가 표본 수")).toHaveText("6");
  await expect(value(dialog, "승인 요구 예상")).toHaveText("5");
  await expect(value(dialog, "허용 예상")).toHaveText("1");
});

test("SIMULATION-LIVE-004 복원하지 못하는 비밀정보 조건의 0건을 안전 판정으로 표시하지 않는다", async ({
  page,
}) => {
  await login(page, admin, policyPath);
  const dialog = await simulate(page, "민감정보 차단 정책 추가");
  await expect(value(dialog, "평가 표본 수")).toHaveText("8");
  await expect(value(dialog, "차단 예상")).toHaveText("0");
  await expect(value(dialog, "허용 예상")).toHaveText("8");
  await expect(dialog).toContainText("당시 값을 복원하지 못하는 조건이 있습니다.");
  await expect(dialog).toContainText("비밀정보 포함");
  await expect(dialog).toContainText("미래 요청의 안전성을 보장하지 않습니다.");
});

test("SIMULATION-LIVE-005 조회 계정의 라우팅 접근과 정책 실행을 화면·서버에서 차단", async ({ page }) => {
  await login(page, reader, routingPath);
  await expect(page.getByRole("alert")).toContainText("접근 권한이 없습니다.");
  await page.goto(policyPath);
  await expect(
    page.getByRole("button", { name: `${costSuggestion} 섀도우 영향 확인`, exact: true }),
  ).toBeDisabled();
  const statuses = await page.evaluate(
    async ({ previewEndpoint, simulationEndpoint }) => {
      const headers = {
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        "Content-Type": "application/json",
      };
      const preview = await fetch(previewEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ model: "browser-order-request" }),
      });
      const simulation = await fetch(simulationEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify({ rules: [{ actions: { block: true } }] }),
      });
      return [preview.status, simulation.status];
    },
    { previewEndpoint, simulationEndpoint },
  );
  expect(statuses).toEqual([401, 401]);
});
