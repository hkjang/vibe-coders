import { expect } from "@playwright/test";
import { admin, login, test } from "./live-fixture";

test("AUTH-LIVE-035 실제 MCP 호출 검토와 격리 업스트림 실행", async ({ page }) => {
  await login(page, admin, "/app/mcp");
  await page.getByLabel("노출 이름", { exact: true }).fill("browser-call__echo");
  await page.getByLabel("JSON 인수", { exact: true }).fill('{"text":"browser reviewed"}');
  await page.getByRole("button", { name: "적용 경로 확인", exact: true }).click();
  const trigger = page.getByRole("button", { name: "테스트 호출 검토", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "실제 MCP 호출 검토", exact: true });
  const submit = dialog.getByRole("button", { name: "검토한 호출 실행", exact: true });
  await expect(submit).toBeDisabled();
  await expect(dialog.getByText("호출 검증 서버", { exact: true })).toBeVisible();
  await dialog.getByLabel("확인 문구", { exact: false }).fill("실제 호출");
  const response = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/admin/mcp/test" && r.request().method() === "POST",
  );
  await submit.click();
  expect((await response).status()).toBe(200);
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("호출 성공", { exact: true })).toBeVisible();
  await expect(trigger).toBeDisabled();
  await page.getByText("응답 미리보기 열기", { exact: true }).click();
  await expect(page.locator(".mcp-call-preview")).toContainText("called echo");
  // Go verifies the exact invocation count and arguments without logging them.
});

test("AUTH-LIVE-034 실제 MCP 연결 구조와 상세 주소 복원", async ({ page }) => {
  await login(page, admin, "/app/mcp?tab=topology");
  await page.getByRole("button", { name: "검색검증 MCP 서버 목록 상세", exact: true }).click();
  const detail = page.getByRole("dialog", { name: "MCP 연결 상세", exact: true });
  await expect(detail.getByText("upstream:browser-search-mcp", { exact: true })).toBeVisible();
  await expect(detail.getByText("중지", { exact: true })).toBeVisible();
  await expect(detail.getByText("게이트웨이 통합", { exact: true })).toBeVisible();
  await page.reload();
  await expect(detail.getByText("upstream:browser-search-mcp", { exact: true })).toBeVisible();
  await detail.getByRole("button", { name: "선택 해제", exact: true }).click();
  await expect(detail).toHaveCount(0);
  expect(new URL(page.url()).searchParams.has("node")).toBe(false);
});

test("AUTH-LIVE-032 실제 MCP 도구 위험 설정 검토와 저장", async ({ page }) => {
  await login(page, admin, "/app/mcp?tab=tools&server=browser-risk-server&tool=write_record");
  await page
    .getByRole("button", { name: "browser-risk-server write_record 위험 등급 편집", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "도구 위험 등급", exact: true });
  const save = dialog.getByRole("button", { name: "검토한 변경 저장", exact: true });
  await expect(save).toBeDisabled();
  await dialog.getByLabel("위험 등급", { exact: false }).selectOption("critical");
  await dialog.getByLabel("메모", { exact: true }).fill("browser reviewed");
  await expect(dialog.getByText("변경 전: 높음", { exact: true })).toBeVisible();
  await expect(dialog.getByText("변경 후: 심각", { exact: true })).toBeVisible();
  const posted = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/admin/mcp/tools" && response.request().method() === "POST",
  );
  await save.click();
  expect((await posted).status()).toBe(201);
  await expect(dialog).toHaveCount(0);
  const table = page.getByRole("table", { name: "MCP 도구 위험 등급", exact: true });
  await expect(table.getByText("심각", { exact: true })).toBeVisible();
  await page.reload();
  await expect(table.getByText("심각", { exact: true })).toBeVisible();
  await page.goto("/app/mcp?tab=requests&server=browser-risk-server&tool=write_record");
  const details = page.getByRole("button", { name: "browser_mcp_risk 처리 흐름 열기", exact: true });
  await details.click();
  const flow = page.getByRole("dialog", { name: "MCP 요청 처리 흐름", exact: true });
  await expect(flow.getByText("호출 당시의 정책 기록과 구분하세요.", { exact: true })).toBeVisible();
  await expect(flow.getByRole("table", { name: "요청의 도구 호출", exact: true })).toContainText(
    "write_record",
  );
  await expect(flow.getByRole("table", { name: "MCP 요청 처리 단계", exact: true })).toContainText(
    "현재 서버 정책",
  );
  await page.reload();
  await expect(flow.getByRole("table", { name: "요청의 도구 호출", exact: true })).toContainText(
    "write_record",
  );
  await flow.getByRole("button", { name: "패널 닫기", exact: true }).click();
  await expect(details).toBeVisible();
  // Go's harness separately verifies the stored row and exactly one audit event.
});

test("AUTH-LIVE-033 실제 MCP 정책 검토·편집·허용목록·삭제", async ({ page }) => {
  await login(page, admin, "/app/mcp?tab=policy");
  await page.getByRole("button", { name: "정책 추가", exact: true }).click();
  const create = page.getByRole("dialog", { name: "MCP 서버 정책 추가", exact: true });
  await create.getByLabel("서버 라벨", { exact: false }).fill("browser-policy-reviewed");
  await create.getByLabel("모드", { exact: false }).selectOption("block");
  await create.getByLabel("메모", { exact: true }).fill("browser policy baseline");
  await create.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect(create).toHaveCount(0);
  await page.getByRole("button", { name: "browser-policy-reviewed 정책 편집", exact: true }).click();
  const edit = page.getByRole("dialog", { name: "MCP 서버 정책 편집", exact: true });
  await expect(edit.getByRole("button", { name: "검토한 정책 저장", exact: true })).toBeDisabled();
  await edit.getByLabel("모드", { exact: false }).selectOption("warn");
  await edit.getByLabel("메모", { exact: true }).fill("browser policy reviewed");
  await expect(edit.getByText("변경 전: 차단", { exact: false })).toBeVisible();
  await edit.getByRole("button", { name: "검토한 정책 저장", exact: true }).click();
  await expect(edit).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("table", { name: "MCP 서버 정책", exact: true })).toContainText(
    "browser policy reviewed",
  );
  for (const target of ["허용목록 사용", "허용목록 해제"]) {
    await page.getByRole("button", { name: "허용목록 변경 검토", exact: true }).click();
    const confirm = page.getByRole("dialog", { name: "허용목록 모드를 변경할까요?", exact: true });
    const apply = confirm.getByRole("button", { name: "검토한 모드 적용", exact: true });
    await expect(apply).toBeDisabled();
    await confirm.getByLabel("확인 문구", { exact: false }).fill(target);
    await apply.click();
    await expect(confirm).toHaveCount(0);
  }
  await page.getByRole("button", { name: "browser-policy-reviewed 정책 삭제", exact: true }).click();
  const remove = page.getByRole("dialog", { name: "정책을 삭제할까요?", exact: true });
  await expect(remove.getByText("삭제 후: 미등록 · 서버 기본 허용", { exact: true })).toBeVisible();
  await remove.getByLabel("확인 문구", { exact: false }).fill("browser-policy-reviewed");
  await remove.getByRole("button", { name: "삭제", exact: true }).click();
  await expect(remove).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole("button", { name: "browser-policy-reviewed 정책 편집", exact: true }),
  ).toHaveCount(0);
  // The Go harness checks final state and exactly five matching audit events.
});
