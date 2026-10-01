import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Action,
  type RoutingToggleGateway,
  routingUrl,
  listPath,
  firstEmail,
  secondEmail,
  ruleA,
  ruleB,
  rule,
  requestId,
  readonlyReason,
} from "../fixtures/routing-toggle-review-gateway";

// Actual React/router interactions against synthetic HTTP only. Captured React
// callbacks/validation races have separate unit evidence; no forced DOM click
// below is presented as API admission, Go authorization, CAS or cancellation.
const dialogFor = (page: Page, enabled = true) =>
  page.getByRole("dialog", { name: `라우팅 규칙 ${enabled ? "중지" : "사용"}`, exact: true });
const confirm = (dialog: Locator, enabled = true) =>
  dialog.getByRole("button", { name: enabled ? "중지" : "사용", exact: true });
const detail = (dialog: Locator, label: string) => dialog.getByText(label, { exact: true }).locator("+ dd");
const writes = (gateway: RoutingToggleGateway) =>
  gateway.operations.filter((item) => item.action === "patch");
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(routingUrl)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
  await expect(page.getByRole("table", { name: "복잡도 기반 라우팅 규칙 목록", exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function refresh(page: Page, dialog?: Locator) {
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === listPath && item.request().method() === "GET",
  );
  await (dialog ?? page)
    .getByRole("button", { name: dialog ? "목록 다시 조회" : "새로고침", exact: true })
    .click();
  await (await response).finished();
}
async function open(page: Page, original = rule()) {
  const trigger = page.getByRole("button", {
    name: `${original.match_pattern || "*"} → ${original.target_model} 규칙 ${original.enabled ? "중지" : "사용"}`,
    exact: true,
  });
  await trigger.click();
  const dialog = dialogFor(page, original.enabled);
  await expect(dialog).toBeVisible();
  await expect(detail(dialog, "변경 후 상태")).toHaveText(original.enabled ? "중지됨" : "사용 중");
  return { dialog, trigger };
}
async function release(gateway: RoutingToggleGateway, action: Action) {
  const finished = gateway.finished.filter((item) => item === action).length;
  gateway.release(action);
  await expect.poll(() => gateway.finished.filter((item) => item === action).length).toBe(finished + 1);
}
async function acknowledgeLatest(dialog: Locator) {
  await dialog.getByRole("button", { name: "최신 기준 다시 확인", exact: true }).click();
  await expect(confirm(dialog)).toBeEnabled();
}

for (const enabled of [true, false]) {
  test(`정상 ${enabled ? "중지" : "사용"}는 검토한 같은 ID에 명시 enabled만 PATCH 1`, async ({
    page,
    gateway,
  }) => {
    const original = rule(ruleA, enabled),
      other = rule(ruleB);
    gateway.setRows([original, other]);
    await login(page);
    const { dialog } = await open(page, original);
    for (const [label, value] of [
      ["원본 규칙 ID", ruleA],
      ["모델 패턴", original.match_pattern],
      ["대상 모델", original.target_model],
      ["대상 공급자", original.target_provider],
      ["우선순위", "10"],
      ["복잡도 범위", "0–40"],
      ["변경 전 상태", enabled ? "사용 중" : "중지됨"],
    ] as const)
      await expect(detail(dialog, label)).toHaveText(value);
    const button = confirm(dialog, enabled);
    const exactButton = await button.elementHandle();
    if (!exactButton) throw new Error("Missing original confirmation button");
    await button.evaluate((node) => {
      node.setAttribute("data-native-clicks", "0");
      node.addEventListener("click", () =>
        node.setAttribute("data-native-clicks", String(Number(node.getAttribute("data-native-clicks")) + 1)),
      );
    });
    gateway.hold("patch");
    await button.click();
    await expect.poll(() => exactButton.getAttribute("data-native-clicks")).toBe("1");
    await expect.poll(() => gateway.count("patch")).toBe(1);
    expect(writes(gateway).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: `${listPath}/${ruleA}`, body: { enabled: !enabled } },
    ]);
    expect(gateway.records()).toEqual([{ ...original, enabled: !enabled }, other]);
    await release(gateway, "patch");
    await expect(dialog).toBeHidden();
  });
}
for (const close of ["cancel", "escape"] as const) {
  test(`${close}는 확인 없이 PATCH 0, 정확한 원래 버튼으로 포커스 복원`, async ({ page, gateway }) => {
    await login(page);
    const { dialog, trigger } = await open(page);
    if (close === "cancel") await dialog.getByRole("button", { name: "취소", exact: true }).click();
    else await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    expect(writes(gateway)).toEqual([]);
    expect(gateway.records()).toEqual([rule(), rule(ruleB)]);
  });
}
for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`${mode} 전환은 같은 확인창·기준을 보존하고 복구 후 수동으로만 전송`, async ({ page, gateway }) => {
    await login(page);
    const { dialog } = await open(page);
    await dialog.evaluate((node) => node.setAttribute("data-public-opening", "unchanged"));
    gateway.setMode(mode);
    await runtime(page);
    await expect(dialog).toHaveAttribute("data-public-opening", "unchanged");
    await expect(dialog.getByText(readonlyReason, { exact: true })).toBeVisible();
    await expect(detail(dialog, "대상 모델")).toHaveText(rule().target_model);
    await expect(confirm(dialog)).toBeDisabled();
    await refresh(page, dialog);
    await expect(confirm(dialog)).toBeDisabled();
    expect(writes(gateway)).toEqual([]);
    gateway.setMode("writable");
    await runtime(page);
    await expect(confirm(dialog)).toBeEnabled();
    expect(writes(gateway)).toEqual([]);
    await confirm(dialog).click();
    await expect(dialog).toBeHidden();
    expect(writes(gateway).map((item) => item.body)).toEqual([{ enabled: false }]);
  });
}
test("routing:write 회수는 열린 검토만 잠그고 조회·취소와 수동 복구를 유지한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const { dialog } = await open(page);
  gateway.setWrite(false);
  await runtime(page);
  await expect(confirm(dialog)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeEnabled();
  await expect(dialog).toContainText("routing:write");
  await refresh(page, dialog);
  expect(writes(gateway)).toEqual([]);
  gateway.setWrite(true);
  await runtime(page);
  await expect(confirm(dialog)).toBeEnabled();
  expect(writes(gateway)).toEqual([]);
  await confirm(dialog).click();
  await expect(dialog).toBeHidden();
  expect(gateway.count("patch")).toBe(1);
});
for (const change of ["changed", "deleted", "error"] as const) {
  test(`${change} 재조회는 오래된 기준을 잠그고 명시적 최신 확인 후 원래 중지 의도를 유지한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const { dialog } = await open(page);
    const updated = {
      ...rule(),
      target_model: "public-revised-model",
      priority: 31,
      note: "재확인할 공개 메모",
    };
    if (change === "changed") gateway.setRows([updated, rule(ruleB)]);
    else if (change === "deleted") gateway.setRows([rule(ruleB)]);
    else gateway.setStatus("list", 503);
    await refresh(page, dialog);
    await expect(confirm(dialog)).toBeDisabled();
    await expect(detail(dialog, "대상 모델")).toHaveText(rule().target_model);
    if (change === "error") await expect(dialog).toContainText(requestId);
    if (change === "deleted") await expect(dialog).toContainText("선택한 규칙이 현재 목록에 없습니다.");
    expect(writes(gateway)).toEqual([]);
    gateway.setStatus("list", 200);
    gateway.setRows([updated, rule(ruleB)]);
    await refresh(page, dialog);
    await expect(confirm(dialog)).toBeDisabled();
    await acknowledgeLatest(dialog);
    await expect(detail(dialog, "대상 모델")).toHaveText(updated.target_model);
    await expect(detail(dialog, "우선순위")).toHaveText("31");
    await expect(detail(dialog, "변경 후 상태")).toHaveText("중지됨");
    expect(writes(gateway)).toEqual([]);
    await confirm(dialog).click();
    await expect(dialog).toBeHidden();
    expect(writes(gateway).map((item) => item.body)).toEqual([{ enabled: false }]);
    expect(gateway.records()).toEqual([{ ...updated, enabled: false }, rule(ruleB)]);
  });
}
test("이미 원래 의도대로 중지된 최신 행은 반대로 사용 처리하지 않는다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await open(page);
  gateway.setRows([rule(ruleA, false), rule(ruleB)]);
  await refresh(page, dialog);
  await expect(dialog).toContainText("반대 작업은 창을 닫고 다시 선택하세요.");
  await expect(confirm(dialog)).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "최신 기준 다시 확인", exact: true })).toBeDisabled();
  await expect(detail(dialog, "변경 후 상태")).toHaveText("중지됨");
  expect(writes(gateway)).toEqual([]);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  const next = await open(page, rule(ruleA, false));
  await confirm(next.dialog, false).click();
  await expect(next.dialog).toBeHidden();
  expect(writes(gateway).map((item) => item.body)).toEqual([{ enabled: true }]);
});
test("목록 재조회가 진행 중이면 기존 성공 데이터를 변경 허가로 사용하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const { dialog } = await open(page);
  const before = gateway.count("list");
  gateway.hold("list");
  await dialog.getByRole("button", { name: "목록 다시 조회", exact: true }).click();
  await expect.poll(() => gateway.count("list")).toBe(before + 1);
  await expect(confirm(dialog)).toBeDisabled();
  expect(writes(gateway)).toEqual([]);
  await release(gateway, "list");
  await expect(confirm(dialog)).toBeEnabled();
  expect(writes(gateway)).toEqual([]);
});
test("허용 후 대기 중에는 중복·닫기를 막고 readonly 전환 후 이미 보낸 결과는 사실대로 완료한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const { dialog } = await open(page);
  gateway.hold("patch");
  await confirm(dialog).click();
  await expect.poll(() => gateway.count("patch")).toBe(1);
  const pending = dialog.getByRole("button", { name: "처리 중", exact: true });
  await expect(pending).toBeDisabled();
  // A real keyboard activation attempt on a disabled control is not evidence
  // of direct React callback entry; the operation guard has separate units.
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  for (const name of ["취소", "목록 다시 조회", "최신 기준 다시 확인"]) {
    await expect(dialog.getByRole("button", { name, exact: true })).toBeDisabled();
  }
  expect(gateway.count("patch")).toBe(1);
  gateway.setMode("read_only");
  await runtime(page);
  await release(gateway, "patch");
  await expect(dialog).toBeHidden();
  await expect(page.getByText("규칙 사용을 중지했습니다.", { exact: true })).toBeVisible();
  expect(gateway.records().find((item) => item.id === ruleA)?.enabled).toBe(false);
  expect(gateway.count("patch")).toBe(1);
});
test("PATCH 오류는 요청 ID·대상·의도를 유지하며 수동 재시도만 허용한다", async ({ page, gateway }) => {
  await login(page);
  const { dialog } = await open(page);
  gateway.setStatus("patch", 503);
  await confirm(dialog).click();
  await expect(dialog.getByRole("alert")).toContainText(requestId);
  await expect(detail(dialog, "원본 규칙 ID")).toHaveText(ruleA);
  await expect(confirm(dialog)).toBeEnabled();
  expect(gateway.count("patch")).toBe(1);
  gateway.setStatus("patch", 200);
  await confirm(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway)).toHaveLength(2);
  expect(writes(gateway)[1]).toEqual(writes(gateway)[0]);
});
test("PATCH 성공 후 GET 실패는 변경 실패나 자동 PATCH 재실행으로 바뀌지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const { dialog } = await open(page);
  gateway.setStatus("list", 503);
  const response = page.waitForResponse(
    (item) => new URL(item.url()).pathname === listPath && item.request().method() === "GET",
  );
  await confirm(dialog).click();
  await (await response).finished();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("규칙 사용을 중지했습니다.", { exact: true })).toBeVisible();
  expect(gateway.records().find((item) => item.id === ruleA)?.enabled).toBe(false);
  expect(gateway.count("patch")).toBe(1);
  gateway.setStatus("list", 200);
  await refresh(page);
  await expect(
    page.getByRole("button", { name: "public-a-* → public-model-a 규칙 사용", exact: true }),
  ).toBeEnabled();
  expect(gateway.count("patch")).toBe(1);
});
for (const status of [200, 503]) {
  test(`이전 계정의 늦은 ${status}는 같은 문서 새 계정 확인창·알림·조회에 반영되지 않는다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    const { dialog } = await open(page);
    await page.evaluate(() => {
      (window as unknown as { routingMarker: string }).routingMarker = "public-same-document";
    });
    gateway.setStatus("patch", status);
    gateway.hold("patch");
    await confirm(dialog).click();
    await expect.poll(() => gateway.count("patch")).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    expect(await page.evaluate(() => (window as unknown as { routingMarker?: string }).routingMarker)).toBe(
      "public-same-document",
    );
    const next = await open(page, rule(ruleB));
    const reads = gateway.count("list");
    await release(gateway, "patch");
    await page.waitForTimeout(400);
    await expect(next.dialog).toBeVisible();
    await expect(detail(next.dialog, "원본 규칙 ID")).toHaveText(ruleB);
    await expect(next.dialog.getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.count("list")).toBe(reads);
    expect(writes(gateway).map(({ userId }) => userId)).toEqual(["routing-one"]);
    gateway.setStatus("patch", 200);
    await confirm(next.dialog).click();
    await expect(next.dialog).toBeHidden();
    expect(writes(gateway).at(-1)?.userId).toBe("routing-two");
    // An old aborted HTTP response may never reach JS. This scenario does not
    // establish overlap between an old completion and a new pending flight.
    await other.close();
  });
}
test("routing:read 회수 후에는 기존 확인창을 폐기하고 새 목록 조회도 보내지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await open(page);
  const reads = gateway.count("list");
  gateway.setRead(false);
  await runtime(page);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(gateway.count("list")).toBe(reads);
  expect(writes(gateway)).toEqual([]);
});
test("공백·FEFF·예약 문자가 있는 원본 ID는 정규화 없이 한 번 인코딩한 동일 ID를 변경한다", async ({
  page,
  gateway,
}) => {
  const opaque = " \ufeff한글%?값#끝 ",
    original = rule(opaque);
  gateway.setRows([original, rule(ruleB)]);
  await login(page);
  const { dialog } = await open(page, original);
  expect(await detail(dialog, "원본 규칙 ID").textContent()).toBe(opaque);
  await confirm(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway).map(({ id, path }) => ({ id, path }))).toEqual([
    { id: opaque, path: `${listPath}/${encodeURIComponent(opaque)}` },
  ]);
  expect(gateway.records()).toEqual([{ ...original, enabled: false }, rule(ruleB)]);
});
test("dot segment와 슬래시 원본 ID는 다른 경로의 PATCH로 바뀌지 않는다", async ({ page, gateway }) => {
  gateway.setRows(
    [".", "..", "public/child"].map((id, index) => ({ ...rule(id), target_model: `public-unsafe-${index}` })),
  );
  await login(page);
  for (let index = 0; index < 3; index++) {
    const button = page.getByRole("button", {
      name: `public-a-* → public-unsafe-${index} 규칙 중지`,
      exact: true,
    });
    await expect(button).toBeDisabled();
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeInViewport({ ratio: 1 });
    const box = await button.boundingBox();
    if (!box) throw new Error("Missing disabled rule button geometry");
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(
      await button.evaluate((node, point) => {
        const hit = document.elementFromPoint(point.x, point.y);
        return hit === node || (hit !== null && node.contains(hit));
      }, center),
    ).toBe(true);
    await button.evaluate((node) => {
      node.setAttribute("data-native-clicks", "0");
      node.addEventListener("click", () => node.setAttribute("data-native-clicks", "1"));
    });
    // Real pointer attempt on an unchanged disabled control. This establishes
    // native disabled behavior, not React callback entry (covered by units).
    await page.mouse.click(center.x, center.y);
    await expect(button).toHaveAttribute("data-native-clicks", "0");
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  expect(writes(gateway)).toEqual([]);
});
test("선택창의 런타임 접두사 마스킹은 표시만 바꾸고 원본 ID와 enabled-only 전송은 보존한다", async ({
  page,
  gateway,
}) => {
  const prefix = "public_synthetic_prefix_",
    marker = `${prefix}${"a".repeat(32)}`;
  const original = {
    ...rule(),
    match_pattern: marker,
    target_model: marker,
    target_provider: marker,
    note: marker,
  };
  gateway.setPrefixes([prefix]);
  gateway.setRows([original, rule(ruleB)]);
  await login(page);
  // Table and review display are masked; the transport and stored values remain unchanged.
  expect(
    await page
      .getByRole("table", { name: "복잡도 기반 라우팅 규칙 목록", exact: true })
      .evaluate((node, value) => node.outerHTML.includes(value), marker),
  ).toBe(false);
  const masked = "민감정보가 포함될 수 있어 표시하지 않습니다.";
  await page.getByRole("button", { name: `${masked} → ${masked} 규칙 중지`, exact: true }).click();
  const dialog = dialogFor(page, original.enabled);
  await expect(dialog).toBeVisible();
  await expect(detail(dialog, "변경 후 상태")).toHaveText("중지됨");
  expect(await page.locator("body").evaluate((node, value) => node.outerHTML.includes(value), marker)).toBe(
    false,
  );
  expect(await dialog.evaluate((node, value) => node.outerHTML.includes(value), marker)).toBe(false);
  await expect(dialog.getByText("민감정보가 포함될 수 있어 표시하지 않습니다.", { exact: true })).toHaveCount(
    4,
  );
  await confirm(dialog).click();
  await expect(dialog).toBeHidden();
  expect(writes(gateway).map(({ id, body }) => ({ id, body }))).toEqual([
    { id: ruleA, body: { enabled: false } },
  ]);
  expect(gateway.records()[0]).toEqual({ ...original, enabled: false });
});
async function axe(page: Page) {
  return page.evaluate(async () => {
    const engine = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    return (await engine.run(document)).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
}
async function noOverflow(page: Page, dialog: Locator) {
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const value of await dialog.locator("dd").all())
    expect(await value.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}
test("390px 다크 긴 원문 검토는 키보드·넘침·axe와 스크롤 후 첫 확정 클릭을 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  const original = {
    ...rule(`public_${"긴원본".repeat(28)}`),
    target_model: `public-${"긴대상모델".repeat(26)}`,
    note: "공개 긴 검토 메모 ".repeat(45),
  };
  gateway.setRows([original]);
  await login(page);
  const { dialog } = await open(page, original);
  expect(await detail(dialog, "원본 규칙 ID").textContent()).toBe(original.id);
  expect(await detail(dialog, "대상 모델").textContent()).toBe(original.target_model);
  await noOverflow(page, dialog);
  for (let step = 0; step < 7; step++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  }
  gateway.setMode("read_only");
  await runtime(page);
  await expect(confirm(dialog)).toBeDisabled();
  await page.screenshot({ path: info.outputPath("routing-readonly-original-position.png") });
  const reason = dialog.getByText(readonlyReason, { exact: true });
  await reason.scrollIntoViewIfNeeded();
  await expect(reason).toBeInViewport({ ratio: 1 });
  await noOverflow(page, dialog);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("routing-readonly-explicit-scroll.png") });
  gateway.setMode("writable");
  await runtime(page);
  const button = confirm(dialog);
  await expect(button).toBeEnabled();
  const exactButton = await button.elementHandle();
  if (!exactButton) throw new Error("Missing mobile confirmation button");
  // Explicit user-visible scrolling, not an automatic/sticky-footer claim.
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  const y = (await button.boundingBox())?.y;
  await button.evaluate((node) => {
    node.setAttribute("data-native-clicks", "0");
    node.addEventListener("click", () =>
      node.setAttribute("data-native-clicks", String(Number(node.getAttribute("data-native-clicks")) + 1)),
    );
  });
  gateway.hold("patch");
  await button.click();
  await expect.poll(() => exactButton.getAttribute("data-native-clicks")).toBe("1");
  expect((await exactButton.boundingBox())?.y).toBe(y);
  await expect.poll(() => gateway.count("patch")).toBe(1);
  await noOverflow(page, dialog);
  await expect(dialog.getByRole("button", { name: "처리 중", exact: true })).toBeInViewport({ ratio: 1 });
  // This ConfirmDialog scrolls its outer dialog, not .dialog-body. During
  // pending the header Close remains focusable but cannot dismiss the operation.
  const close = dialog.getByRole("button", { name: "대화상자 닫기", exact: true });
  for (let step = 0; step < 8; step++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (await close.evaluate((node) => node === document.activeElement)) break;
  }
  await expect(close).toBeFocused();
  expect(await dialog.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  const scrollTop = await dialog.evaluate((node) => node.scrollTop);
  await page.keyboard.press("PageDown");
  await expect.poll(() => dialog.evaluate((node) => node.scrollTop)).toBeGreaterThan(scrollTop);
  expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
  expect(await axe(page)).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  expect(gateway.count("patch")).toBe(1);
  await dialog.getByRole("button", { name: "처리 중", exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByRole("button", { name: "처리 중", exact: true })).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("routing-pending-explicit-scroll.png") });
  const reads = gateway.count("list");
  gateway.hold("list");
  await release(gateway, "patch");
  await expect(dialog).toBeHidden();
  await expect.poll(() => gateway.count("list")).toBe(reads + 1);
  // The current row button is disabled during the post-commit GET. Focus falls
  // back to the visible routing panel; a late GET must not steal it again.
  const panel = page.locator(".routing-panel-stack");
  await expect(panel).toBeVisible();
  await expect(panel).toBeFocused();
  await release(gateway, "list");
  await expect(
    page.getByRole("button", {
      name: `${original.match_pattern} → ${original.target_model} 규칙 사용`,
      exact: true,
    }),
  ).toBeEnabled();
  await expect(panel).toBeFocused();
  expect(gateway.count("patch")).toBe(1);
});
