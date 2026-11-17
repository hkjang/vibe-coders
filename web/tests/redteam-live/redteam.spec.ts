import { expect, test, type Page, type Locator } from "@playwright/test";
import { login, reader, required } from "../auth-live/live-fixture";

const names = {
  simulation: "시뮬레이션 확인",
  live: "실제 호출 확인",
  recording: "저장 실패 확인",
  redirect: "주소 변경 차단",
  stale: "검토 변경 확인",
};
type Scenario = keyof typeof names;
let reviews = 0;
let executions = 0;

test.beforeEach(async ({ context, baseURL }) => {
  reviews = 0;
  executions = 0;
  const origin = new URL(baseURL ?? required("APP_BASE_URL")).origin;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.origin).toBe(origin);
    if (request.method() === "POST" && url.pathname.endsWith("/run-review")) reviews += 1;
    if (request.method() === "POST" && url.pathname.endsWith("/run-reviewed")) executions += 1;
    return route.continue(); // Real Go authentication and business responses only.
  });
});

async function prepare(page: Page, scenario: Scenario): Promise<Locator> {
  await page.getByRole("button", { name: `${names[scenario]} 실제 실행`, exact: true }).click();
  if (scenario === "simulation") await page.getByLabel("이번 실행 방식").selectOption("simulation");
  await page.getByLabel("실행 사유", { exact: false }).fill("격리 브라우저 업무 검증");
  await page
    .getByLabel("실제 모델 호출 수 상한", { exact: false })
    .fill(scenario === "recording" ? "2" : "1");
  await page.getByLabel("호출당 출력 토큰 요청 상한", { exact: false }).fill("77");
  if (scenario === "recording") await page.getByLabel("정확한 모델 이름").fill("test-model\nsecond-model");
  await page.getByRole("button", { name: "실행 조건 검토", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "실행 조건 최종 확인" });
  await expect(panel).toBeVisible();
  const planned = scenario === "simulation" ? 0 : scenario === "recording" ? 2 : 1;
  const limit = scenario === "recording" ? 2 : 1;
  await expect(panel.getByText("실제 모델 호출", { exact: true }).locator("..")).toContainText(
    `${planned}건 / 상한 ${limit}건`,
  );
  expect(executions).toBe(0);
  return panel;
}

async function open(page: Page, scenario: Scenario): Promise<Locator> {
  await login(page, undefined, "/app/redteam?tab=campaigns");
  const campaignRow = page.getByRole("row").filter({ has: page.getByText(names[scenario], { exact: true }) });
  await expect(campaignRow.getByText("제공자·모델", { exact: true })).toBeVisible();
  await expect(campaignRow.getByText("제한된 실제 실행", { exact: true })).toBeVisible();
  if (scenario !== "simulation") await page.getByLabel(/실행 키/u).fill(required("VIBE_REDTEAM_BROWSER_KEY"));
  return prepare(page, scenario);
}

async function execute(page: Page, panel: Locator, scenario: Scenario): Promise<Locator> {
  const action = panel.getByRole("button", { name: "검토한 조건으로 한 번 실행", exact: true });
  await expect(action).toBeDisabled();
  await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill(names[scenario]);
  await action.click();
  const outcome = page.getByRole("dialog", { name: "캠페인 실행 결과", exact: true });
  await expect(outcome).toBeVisible();
  expect(executions).toBe(1);
  return outcome;
}

test("REDTEAM-LIVE-001 시뮬레이션 검토 취소와 저장 확인", async ({ page }) => {
  let panel = await open(page, "simulation");
  await panel.getByRole("button", { name: "닫기", exact: true }).click();
  expect(reviews).toBe(1);
  expect(executions).toBe(0);
  panel = await prepare(page, "simulation");
  const outcome = await execute(page, panel, "simulation");
  await expect(outcome.getByText("확인됨", { exact: true })).toBeVisible();
  await expect(outcome.getByText("완료", { exact: true })).toBeVisible();
  expect(reviews).toBe(2);
});

test("REDTEAM-LIVE-002 실제 호출의 결과와 이력", async ({ page }) => {
  const panel = await open(page, "live");
  const outcome = await execute(page, panel, "live");
  await expect(outcome.getByText("확인됨", { exact: true })).toBeVisible();
  await expect(outcome.getByText("완료", { exact: true })).toBeVisible();
  await outcome.getByRole("button", { name: /결과 1건 보기/u }).click();
  await expect(outcome).toBeHidden();
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(reviews).toBe(1);
});

test("REDTEAM-LIVE-003 실제 DB 기록 실패 후 중단과 재전송 금지", async ({ page }) => {
  const panel = await open(page, "recording");
  const outcome = await execute(page, panel, "recording");
  await expect(outcome.getByText("결과 저장을 확인하지 못했습니다.", { exact: true })).toBeVisible();
  await expect(outcome.getByText("저장 확인 필요", { exact: true })).toBeVisible();
  await expect(outcome.getByText("완료", { exact: true })).toHaveCount(0);
  await expect(outcome.getByText("private-browser-recording-fault", { exact: false })).toHaveCount(0);
  await expect(outcome.getByRole("button", { name: /재실행|재개/u })).toHaveCount(0);
  expect(reviews).toBe(1);
  expect(executions).toBe(1);
});

test("REDTEAM-LIVE-004 제공자 리다이렉트는 호출 오류", async ({ page }) => {
  const panel = await open(page, "redirect");
  const outcome = await execute(page, panel, "redirect");
  await expect(outcome.getByText("확인됨", { exact: true })).toBeVisible();
  await expect(outcome.getByText("실패", { exact: true }).locator("..")).toContainText("1");
  await outcome.getByRole("button", { name: /결과 1건 보기/u }).click();
  await expect(
    page.getByRole("dialog", { name: "레드팀 결과", exact: true }).getByText("호출 오류", { exact: true }),
  ).toBeVisible();
  expect(reviews).toBe(1);
  expect(executions).toBe(1);
});

test("REDTEAM-LIVE-005 조회 전용 사용자의 실행 거부", async ({ page }) => {
  await login(page, reader, "/app/redteam?tab=campaigns");
  await expect(page.getByRole("button", { name: `${names.live} 실제 실행`, exact: true })).toBeDisabled();
  const status = await page.evaluate(async () => {
    const response = await fetch("/admin/redteam/campaigns/browser-redteam-live/run-review", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vibe-UI": "app",
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      },
      body: JSON.stringify({
        kind: "live",
        reason: "권한 거부 확인",
        models: [],
        limits: { max_calls: 1, max_output_tokens: 77, budget_limit_krw: 100 },
      }),
    });
    return response.status;
  });
  expect(status).toBe(403);
  expect(executions).toBe(0);
});

test("REDTEAM-LIVE-006 검토 후 변경된 캠페인을 실행하지 않는다", async ({ page }) => {
  const panel = await open(page, "stale");
  const changed = await page.evaluate(async () => {
    const response = await fetch("/admin/redteam/campaigns", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Vibe-UI": "app",
        Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      },
      body: JSON.stringify({
        id: "browser-redteam-stale",
        name: "검토 뒤 변경됨",
        scope: "provider",
        execution_mode: "active-controlled",
        budget_limit_krw: 100,
        probe_pack_ids: ["browser-redteam-pack"],
        target_filter: { target_type: "model", provider: "browser-redteam-stale", models: ["test-model"] },
      }),
    });
    return response.ok;
  });
  expect(changed).toBe(true);
  await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill(names.stale);
  await panel.getByRole("button", { name: "검토한 조건으로 한 번 실행", exact: true }).click();
  await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/u)).toBeVisible();
  await expect(panel.getByRole("button", { name: "검토한 조건으로 한 번 실행", exact: true })).toBeDisabled();
  expect(executions).toBe(1);
  expect(reviews).toBe(1);
});
