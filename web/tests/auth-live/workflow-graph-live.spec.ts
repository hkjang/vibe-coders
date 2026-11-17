import { expect, type Page } from "@playwright/test";
import type { WorkflowGraphReview } from "../../src/shared/api/generated";
import { admin, login, reader, test } from "./live-fixture";
const path = "/app/agents/workflows?workflow=browser-graph";
async function editor(page: Page) {
  await login(page, admin, path);
  await page.getByRole("dialog").getByRole("button", { name: "수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "분기 워크플로 수정", exact: true });
  await expect(dialog.getByLabel("워크플로 이름", { exact: false })).toBeVisible();
  return dialog;
}
test("WORKFLOW-GRAPH-LIVE-001 실제 정의 수정과 감사 저장", async ({ page }) => {
  const dialog = await editor(page);
  await dialog.getByLabel("워크플로 이름", { exact: false }).fill("브라우저 분기 수정");
  await dialog.getByLabel("변경 사유", { exact: false }).fill("browser-graph-edit");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).searchParams.get("review") === "graph",
  );
  await dialog.getByRole("button", { name: "검토한 정의 저장", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByRole("dialog", { name: "브라우저 분기 수정", exact: true })).toBeVisible();
});
test("WORKFLOW-GRAPH-LIVE-002 실제 게시와 버전별 분기 조회", async ({ page }) => {
  await login(page, admin, path);
  await page.getByRole("dialog").getByRole("button", { name: "게시", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "분기 워크플로 게시", exact: true });
  await dialog.getByLabel("변경 사유", { exact: false }).fill("browser-graph-publication");
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/admin/workflows/browser-graph/publish",
  );
  await dialog.getByRole("button", { name: "검토한 정의 게시", exact: true }).click();
  expect((await response).status()).toBe(200);
  await expect(dialog).toBeHidden();
  const detail = page.getByRole("dialog", { name: "브라우저 분기 수정", exact: true });
  await detail.getByRole("button", { name: "버전 이력", exact: true }).click();
  await detail.getByRole("button", { name: "버전 1 정의 보기", exact: true }).click();
  await expect(detail.getByRole("heading", { name: "버전 1 정의", exact: true })).toBeFocused();
  await expect(detail.getByRole("table", { name: "단계 연결", exact: true })).toBeVisible();
});
test("WORKFLOW-GRAPH-LIVE-003 동시 변경 뒤 이전 검토 저장 거부", async ({ page }) => {
  const dialog = await editor(page);
  await dialog.getByLabel("워크플로 이름", { exact: false }).fill("저장되면 안 되는 오래된 수정");
  await dialog.getByLabel("변경 사유", { exact: false }).fill("browser-stale-review");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  const changed = await page.evaluate(async () => {
    const headers = {
      Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
      "Content-Type": "application/json",
    };
    const response = await fetch("/admin/workflows?view=review&id=browser-graph", { headers });
    const review = (await response.json()) as WorkflowGraphReview;
    const { id, name, allowed_teams, enabled, steps, flow } = review.workflow;
    return (
      await fetch("/admin/workflows?review=graph", {
        method: "POST",
        headers,
        body: JSON.stringify({
          workflow: {
            id,
            name,
            description: "browser-competing-change",
            allowed_teams,
            enabled,
            steps,
            flow,
          },
          expected_revision: review.revision,
          reason: "browser-competing-edit",
        }),
      })
    ).status;
  });
  expect(changed).toBe(200);
  const response = page.waitForResponse(
    (r) => r.request().method() === "POST" && new URL(r.url()).searchParams.get("review") === "graph",
  );
  await dialog.getByRole("button", { name: "검토한 정의 저장", exact: true }).click();
  expect((await response).status()).toBe(409);
  await expect(dialog.getByRole("button", { name: "검토한 정의 저장", exact: true })).toBeDisabled();
  await expect(dialog).toContainText("정의가 변경되거나 삭제됐습니다");
});
test("WORKFLOW-GRAPH-LIVE-004 읽기 계정의 직접 저장 거부", async ({ page }) => {
  await login(page, reader, path);
  const status = await page.evaluate(async () => {
    return (
      await fetch("/admin/workflows?review=graph", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}`,
          "Content-Type": "application/json",
        },
        body: "{}",
      })
    ).status;
  });
  expect(status).toBe(401);
});
