import { expect, type Page } from "@playwright/test";
import { test, flowRequestA, flowRequestB, type RequestFlowGateway } from "./fixtures/request-safe-flow";

const left = { ...flowRequestA, request_id: "req-a", request_filterable: true };
const right = { ...flowRequestB, request_id: "req-b", request_filterable: true };
const response = (rows: (typeof left)[]) => ({
  requests: rows,
  limit: 2,
  generated_at: "2026-10-01T00:00:03Z",
});
const table = (page: Page) => page.getByRole("table", { name: "두 요청의 운영 지표 비교" });
async function open(page: Page, gateway: RequestFlowGateway) {
  gateway.authMode("open");
  gateway.rows([left, right]);
  gateway.listReply(2, { body: response([left]) });
  gateway.listReply(3, { body: response([right]) });
  await page.goto("observability/requests");
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
  await page.getByRole("button", { name: "1번째 요청 req-a 상세 보기", exact: true }).click();
}
async function compare(page: Page) {
  await page.getByLabel("비교할 요청 ID").fill("req-b");
  await page.getByRole("button", { name: "비교", exact: true }).click();
}
test("원문 비교 API 없이 두 요청의 안전한 운영 지표를 비교하고 모바일·키보드 접근성을 지킨다", async ({
  page,
  gateway,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  const versions: string[] = [];
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/admin/requests")
      versions.push(req.headers()["x-vibe-app-requests-version"] ?? "");
  });
  await open(page, gateway);
  // Set the header's refresh preference before testing the narrow dialog layout.
  await page.setViewportSize({ width: 390, height: 844 });
  await compare(page);
  await expect(table(page)).toBeVisible();
  await expect(table(page)).toContainText("두 번째 공개 모델");
  expect(gateway.listCalls.slice(1).map((url) => Object.fromEntries(url.searchParams))).toEqual([
    { request_id: "req-a", limit: "2" },
    { request_id: "req-b", limit: "2" },
  ]);
  expect(versions).toEqual(["2", "2", "2"]);
  await page.getByRole("region", { name: "요청 비교 표 가로 스크롤" }).focus();
  await expect(page.getByRole("region", { name: "요청 비교 표 가로 스크롤" })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.addScriptTag({ path: "node_modules/axe-core/axe.min.js" });
  expect(
    await page.evaluate(
      async () =>
        (
          await (
            window as unknown as { axe: { run: (root: Document) => Promise<{ violations: unknown[] }> } }
          ).axe.run(document)
        ).violations,
    ),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("request-comparison-mobile.png") });
});
test("설정 접두사 비밀값은 전송하지 않고 실패 후 이전 비교를 숨기며 명시적으로 다시 조회한다", async ({
  page,
  gateway,
}) => {
  await open(page, gateway);
  await page.getByLabel("비교할 요청 ID").fill("corp_" + "a".repeat(32));
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("비밀정보로 보이는 값");
  await expect(page.getByLabel("비교할 요청 ID")).toBeFocused();
  expect(gateway.listCalls).toHaveLength(1);
  await compare(page);
  await expect(table(page)).toBeVisible();
  gateway.listReply(4, { body: response([left]) });
  gateway.listReply(5, { body: { error: { message: "private detail must not be shown" } }, status: 403 });
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(page.getByText("두 요청을 비교하지 못했습니다.")).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByText("private detail must not be shown")).toHaveCount(0);
  gateway.listReply(6, { body: response([left]) });
  gateway.listReply(7, { body: response([right]) });
  await page.getByRole("button", { name: "비교", exact: true }).click();
  await expect(table(page)).toBeVisible();
  expect(gateway.listCalls).toHaveLength(7);
});
test("계정이 바뀌면 진행 중 비교를 취소하고 늦은 결과를 새 계정에 표시하지 않는다", async ({
  page,
  gateway,
}) => {
  await open(page, gateway);
  gateway.holdList(3);
  await compare(page);
  await expect.poll(() => gateway.listCalls.length).toBe(3);
  const canceled = page.waitForEvent(
    "requestfailed",
    (req) => new URL(req.url()).searchParams.get("request_id") === "req-b",
  );
  gateway.owner("new-comparison-reader");
  const refreshed = page.waitForResponse((reply) => new URL(reply.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await refreshed).finished();
  await canceled;
  gateway.releaseList(3);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "1번째 요청 req-a 상세 보기", exact: true }).click();
  await expect(page.getByLabel("비교할 요청 ID")).toHaveValue("");
  await expect(table(page)).toHaveCount(0);
});
test("정상 비교 후 잘못된 ID를 제출하면 이전 결과를 지우고 새 조회 전까지 복원하지 않는다", async ({
  page,
  gateway,
}) => {
  await open(page, gateway);
  await compare(page);
  await expect(table(page)).toBeVisible();
  for (const invalid of ["", "corp_" + "a".repeat(32)]) {
    const reads = gateway.listCalls.length;
    const input = page.getByLabel("비교할 요청 ID");
    await input.fill(invalid);
    await page.getByRole("button", { name: "비교", exact: true }).click();
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(input).toBeFocused();
    await expect(table(page)).toHaveCount(0);
    expect(gateway.listCalls).toHaveLength(reads);
    await input.fill("req-b");
    await expect(table(page)).toHaveCount(0);
    gateway.listReply(reads + 1, { body: response([left]) });
    gateway.listReply(reads + 2, { body: response([right]) });
    await page.getByRole("button", { name: "비교", exact: true }).click();
    await expect(table(page)).toBeVisible();
    expect(gateway.listCalls).toHaveLength(reads + 2);
  }
});
test("안전한 요약 계약에 원문 필드가 섞인 응답은 표시하지 않는다", async ({ page, gateway }) => {
  await open(page, gateway);
  gateway.listReply(3, { body: { ...response([right]), prompts: [{ content: "unexpected raw content" }] } });
  await compare(page);
  await expect(page.getByText("두 요청을 비교하지 못했습니다.")).toBeVisible();
  await expect(table(page)).toHaveCount(0);
  await expect(page.getByText("unexpected raw content")).toHaveCount(0);
  expect(gateway.listCalls).toHaveLength(3);
});
