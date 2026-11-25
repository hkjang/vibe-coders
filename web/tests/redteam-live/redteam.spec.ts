import { expect, test, type Page, type Locator } from "@playwright/test";
import { login, reader, required } from "../auth-live/live-fixture";
import type { RedTeamReviewedExecutionRequest } from "../../src/shared/api/generated";

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
let replayReviews = 0;
let replays = 0;
let liveJobId = "";

test("REDTEAM-LIVE-009 오래된 실행의 페이지·상세·새로고침", async ({ page }) => {
  await login(
    page,
    reader,
    "/app/redteam?tab=runs&runs_campaign_id=browser-history&runs_sort=id:asc&runs_page=6",
  );
  await expect(page.getByText("조건에 맞는 실행 127건")).toBeVisible();
  await page.getByRole("link", { name: "browser-history-126 실행 상세" }).click();
  const detail = page.getByRole("dialog", { name: "레드팀 결과" });
  await expect(detail.getByText("browser-history-126", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/run=browser-history-126/);
  await page.reload();
  await expect(detail.getByText("browser-history-126", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "패널 닫기" }).click();
  await expect(page).not.toHaveURL(/(?:[?&])run=/);
  await expect(page.getByRole("button", { name: "browser-history-125 결과 보기" })).toBeVisible();
  await page.goBack();
  await expect(detail).toBeVisible();
  expect(executions + replays).toBe(0);
});

test.beforeEach(async ({ context, baseURL }) => {
  reviews = 0;
  executions = 0;
  replayReviews = 0;
  replays = 0;
  const origin = new URL(baseURL ?? required("APP_BASE_URL")).origin;
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    expect(url.origin).toBe(origin);
    if (request.method() === "POST" && url.pathname.endsWith("/run-review")) reviews += 1;
    if (request.method() === "POST" && url.pathname.endsWith("/run-reviewed")) executions += 1;
    if (request.method() === "POST" && url.pathname.endsWith("/rerun-review")) replayReviews += 1;
    if (request.method() === "POST" && url.pathname.endsWith("/rerun-reviewed")) replays += 1;
    expect(url.pathname.endsWith("/rerun")).toBe(false);
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

async function execute(page: Page, panel: Locator, scenario: Scenario, lostReply = false): Promise<Locator> {
  const action = panel.getByRole("button", { name: "검토한 조건으로 한 번 실행", exact: true });
  await expect(action).toBeDisabled();
  await panel.getByLabel("캠페인 이름 확인", { exact: false }).fill(names[scenario]);
  await action.click();
  if (lostReply) {
    await expect(panel.getByText(/실행 결과를 확정할 수 없습니다/u)).toBeVisible();
    await panel.getByRole("button", { name: "닫기", exact: true }).click();
    await page.reload();
  } else await expect(panel).toBeHidden();
  await page.getByRole("button", { name: "저장된 실행 결과" }).click();
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
  let submitted: RedTeamReviewedExecutionRequest | undefined;
  await page.route("**/admin/redteam/campaigns/browser-redteam-live/run-reviewed?job=1", async (route) => {
    executions++;
    submitted = route.request().postDataJSON() as RedTeamReviewedExecutionRequest;
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    // Real Go admission and provider; only the browser response is lost.
    await route.abort("failed");
  });
  const outcome = await execute(page, panel, "live", true);
  liveJobId = new URL(page.url()).searchParams.get("execution_job") ?? "";
  expect(/^rtj_[a-f0-9]{64}$/u.test(liveJobId)).toBe(true);
  await expect(outcome.getByText("확인됨", { exact: true })).toBeVisible();
  await expect(outcome.getByText("완료", { exact: true })).toBeVisible();
  await page.unroute("**/admin/redteam/campaigns/browser-redteam-live/run-reviewed?job=1");
  if (!submitted) throw Error("admission was not observed");
  const duplicate = await page.evaluate(
    async ({ body, id }) => {
      const response = await fetch("/admin/redteam/campaigns/browser-redteam-live/run-reviewed?job=1", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Vibe-UI": "app",
          Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
        },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { id?: string; status?: string };
      return { status: response.status, same: result.id === id, complete: result.status === "completed" };
    },
    { body: submitted, id: liveJobId },
  );
  expect(duplicate).toEqual({ status: 200, same: true, complete: true });
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
  expect(liveJobId).not.toBe("");
  await login(
    page,
    reader,
    `/app/redteam?tab=campaigns&execution_job=${liveJobId}&job_campaign=browser-redteam-live`,
  );
  await expect(page.getByText("레드팀 작업 조회 권한을 확인하세요.")).toBeVisible();
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

for (const scenario of ["replay", "replay-recording"] as const)
  test(`REDTEAM-LIVE-${scenario === "replay" ? "007" : "008"} 한 건 재실행과 ${scenario === "replay" ? "원본 보존" : "저장 실패"}`, async ({
    page,
  }) => {
    await login(page, undefined, "/app/redteam?tab=runs");
    await page.getByLabel("레드팀 실행 키", { exact: true }).fill(required("VIBE_REDTEAM_BROWSER_KEY"));
    await page.getByRole("button", { name: `browser-source-${scenario} 결과 보기`, exact: true }).click();
    await page.getByRole("button", { name: "browser-redteam-case 증적 보기", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "증적 상세", exact: true })
        .getByLabel("요청 프롬프트 (실제 전송 형태 · 마스킹)", { exact: true }),
    ).toHaveText("원본 공개 검사");
    await page.getByRole("button", { name: "조건 검토 후 한 건 재실행", exact: true }).click();
    await page.getByLabel("재실행 사유", { exact: false }).fill("격리 브라우저 한 건 재실행 검증");
    await page.getByLabel("출력 토큰 요청 상한", { exact: false }).fill("77");
    await expect(page.getByRole("checkbox", { name: "새 증적에 입력·응답 원문 보관" })).not.toBeChecked();
    await page.getByRole("button", { name: "재실행 조건 검토", exact: true }).click();
    const panel = page.getByRole("dialog", { name: "한 건 재실행 최종 확인", exact: true });
    await expect(panel).toBeVisible();
    expect(replayReviews).toBe(1);
    expect(replays).toBe(0);
    await expect(panel.getByText("실제 모델 호출", { exact: true }).locator("..")).toContainText(
      "1건 / 상한 1건",
    );
    const action = panel.getByRole("button", { name: "검토한 한 건만 실제 재실행", exact: true });
    await expect(action).toBeDisabled();
    await panel.getByLabel("원본 결과 ID 확인", { exact: false }).fill(`browser-result-${scenario}`);
    await action.click();
    await expect(
      panel.getByText(
        scenario === "replay"
          ? "재실행과 새 결과 저장을 확인했습니다."
          : "일부 실행 또는 저장을 확인하지 못했습니다.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(replays).toBe(1);
    await expect(action).toBeDisabled();
    await expect(panel.getByText("private-browser-recording-fault", { exact: false })).toHaveCount(0);
    await panel.getByRole("button", { name: "새 실행 결과 보기", exact: true }).click();
    const results = page.getByRole("dialog", { name: "레드팀 결과", exact: true });
    await expect(results).toBeVisible();
    await expect(
      results.getByRole("button", { name: "browser-redteam-case 증적 보기", exact: true }),
    ).toHaveCount(scenario === "replay" ? 1 : 0);
    await results.getByRole("button", { name: "패널 닫기", exact: true }).click();
    await page.getByRole("button", { name: `browser-source-${scenario} 결과 보기`, exact: true }).click();
    await page.getByRole("button", { name: "browser-redteam-case 증적 보기", exact: true }).click();
    await expect(
      page
        .getByRole("dialog", { name: "증적 상세", exact: true })
        .getByLabel("요청 프롬프트 (실제 전송 형태 · 마스킹)", { exact: true }),
    ).toHaveText("원본 공개 검사");
    await expect(
      page
        .getByRole("dialog", { name: "증적 상세", exact: true })
        .getByLabel("대상 응답 (마스킹)", { exact: true }),
    ).toHaveText("원본 공개 응답");
    expect(replays).toBe(1);
  });

test("REDTEAM-LIVE-010 원문은 명시적으로 열고 감사 기록을 남긴다", async ({ page }) => {
  let rawReads = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).searchParams.get("reveal") === "raw") rawReads++;
  });
  await login(page, undefined, "/app/redteam?tab=runs&run=browser-source-replay");
  await page.getByRole("button", { name: "browser-redteam-case 증적 보기", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "증적 상세", exact: true });
  await expect(panel.getByLabel("대상 응답 (마스킹)", { exact: true })).toHaveText("원본 공개 응답");
  expect(rawReads).toBe(0);
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveCount(0);
  await panel.getByRole("button", { name: "원문 보기", exact: true }).click();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveText("비공개 브라우저 응답");
  expect(rawReads).toBe(1);
  await panel.getByRole("button", { name: "원문 닫기", exact: true }).click();
  await expect(panel.getByLabel("실제 모델 응답 (원문)")).toHaveCount(0);
  expect(executions + replays).toBe(0);
});

test("REDTEAM-LIVE-011 읽기 전용 계정은 저장된 원문을 내려받지 않는다", async ({ page }) => {
  await login(page, reader, "/app/redteam?tab=runs&run=browser-source-replay");
  const received = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith("/evidence"));
  await page.getByRole("button", { name: "browser-redteam-case 증적 보기", exact: true }).click();
  const response = await received;
  expect(response.status()).toBe(200);
  const body = (await response.json()) as {
    masked: boolean;
    raw_allowed: boolean;
    evidence: { raw_prompt?: string; raw_response?: string };
  };
  expect(body.masked).toBe(true);
  expect(body.raw_allowed).toBe(false);
  expect(body.evidence.raw_prompt ?? "").toBe("");
  expect(body.evidence.raw_response ?? "").toBe("");
  const panel = page.getByRole("dialog", { name: "증적 상세", exact: true });
  await expect(panel.getByLabel("대상 응답 (마스킹)", { exact: true })).toHaveText("원본 공개 응답");
  await expect(panel.getByRole("button", { name: "원문 보기", exact: true })).toHaveCount(0);
  expect(executions + replays).toBe(0);
});
