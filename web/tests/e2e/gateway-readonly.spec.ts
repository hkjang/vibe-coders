import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type Feature,
  firstEmail,
  secondEmail,
  providersUrl,
  healthUrl,
  publicName,
  privateRef,
  originalUrl,
  revisedUrl,
  reason,
} from "../fixtures/gateway-readonly-gateway";

// Synthetic API/browser proof only. Does not execute a provider or operational
// breaker, nor claim that a completed write was rolled back by readonly/logout.
const draft = "읽기 전용 전환 전 공개 SLO 초안";
const publicRow = (page: Page) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name: publicName, exact: true }) });
const privateRow = (page: Page) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name: /공급자 이름 비공개/u }) });
const editor = (page: Page) => page.getByRole("dialog", { name: "공급자 수정", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
const consent = (dialog: Locator) =>
  dialog.getByRole("checkbox", { name: /^조회 범위와 확인하지 못한 영향을 확인했습니다/u });
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
}
async function login(page: Page, path = providersUrl) {
  await page.goto(`login?return_to=${encodeURIComponent(path)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function refreshRuntime(page: Page) {
  const response = page.waitForResponse((item) => new URL(item.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function refreshBehindModal(page: Page, feature: Feature) {
  // The background button is physically inert behind a modal. Invoke its real
  // handler only to prove refetch/draft coordination, not pointer reachability.
  const paths =
    feature === "gateway.providers"
      ? ["/admin/providers", "/admin/providers/slo"]
      : ["/admin/routing/health", "/admin/routing/balancer"];
  const responses = paths.map((path) =>
    page.waitForResponse(
      (response) => response.request().method() === "GET" && new URL(response.url()).pathname === path,
    ),
  );
  await page
    .getByRole("button", { name: "새로고침", exact: true, includeHidden: true })
    .evaluate((element) => (element as HTMLButtonElement).click());
  for (const pending of responses) {
    const response = await pending;
    expect(response.ok()).toBe(true);
    await response.finished();
  }
}
async function acknowledge(dialog: Locator) {
  await expect(consent(dialog)).toBeEnabled();
  await consent(dialog).check();
}
async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "공급자 변경 전후 비교" })).toBeVisible();
  await acknowledge(dialog);
}
async function directSubmit(dialog: Locator) {
  await dialog.locator("form").evaluate((element) => (element as HTMLFormElement).requestSubmit());
}
async function forceConfirm(button: Locator) {
  // Attempt a click after bypassing only the DOM disabled property. React may
  // still suppress its disabled onClick: this proves no request from that
  // attempt, not entry into the callback. Captured-mutate unit tests cover the
  // API-boundary guard separately. Restore the visual property immediately.
  await button.evaluate((element) => {
    const button = element as HTMLButtonElement;
    const disabled = button.disabled;
    button.disabled = false;
    button.click();
    button.disabled = disabled;
  });
}
type Action = "추가" | "편집" | "검토" | "중지" | "삭제" | "비공개 삭제" | "SLO";
async function prepare(page: Page, action: Action) {
  if (action === "추가") {
    await page.getByRole("button", { name: "공급자 추가", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "공급자 추가", exact: true });
    await dialog.getByRole("textbox", { name: "이름", exact: true }).fill("new-public-provider");
    const field = dialog.getByRole("textbox", { name: "기본 URL", exact: true });
    await field.fill(revisedUrl);
    return {
      action,
      dialog,
      field,
      value: revisedUrl,
      save: dialog.getByRole("button", { name: "저장", exact: true }),
      call: "POST /admin/providers",
    };
  }
  if (action === "SLO") {
    await publicRow(page).getByRole("button", { name: "서비스 목표", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "공급자 서비스 수준 목표", exact: true });
    const field = dialog.getByRole("textbox", { name: "메모", exact: true });
    await field.fill(draft);
    return {
      action,
      dialog,
      field,
      value: draft,
      save: dialog.getByRole("button", { name: "저장", exact: true }),
      call: "POST /admin/providers/slo",
    };
  }
  if (action === "삭제" || action === "비공개 삭제") {
    await (action === "삭제" ? publicRow(page) : privateRow(page))
      .getByRole("button", { name: "삭제", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "공급자 삭제", exact: true });
    const value = action === "삭제" ? publicName : privateRef;
    const field = dialog.getByRole("textbox", { name: "삭제 대상 재입력", exact: true });
    await field.fill(value);
    await acknowledge(dialog);
    return {
      action,
      dialog,
      field,
      value,
      save: dialog.getByRole("button", { name: "삭제", exact: true }),
      call: `DELETE /admin/providers/${value}`,
    };
  }
  await publicRow(page)
    .getByRole("button", { name: action === "중지" ? "중지" : "수정", exact: true })
    .click();
  const dialog = editor(page),
    field = dialog.getByRole("textbox", { name: "기본 URL", exact: true });
  if (action !== "중지") await field.fill(revisedUrl);
  if (action !== "편집") await review(dialog);
  return {
    action,
    dialog,
    field: action === "편집" ? field : undefined,
    value: revisedUrl,
    save: dialog.getByRole("button", {
      name: action === "편집" ? "변경 내용 검토" : "검토한 내용 저장",
      exact: true,
    }),
    call: "POST /admin/providers",
  };
}
type Prepared = Awaited<ReturnType<typeof prepare>>;
async function finish(current: Prepared) {
  if (current.action === "편집") {
    await review(current.dialog);
    await current.dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  } else await current.save.click();
  await expect(current.dialog).toBeHidden();
}
async function assertPreserved(current: Prepared) {
  if (current.field) {
    await expect(current.field).toHaveValue(current.value);
    await expect(current.field).toBeDisabled();
  } else {
    await expect(current.dialog.getByRole("table", { name: "공급자 변경 전후 비교" })).toBeVisible();
    if (current.action === "검토") await expect(current.dialog).toContainText(revisedUrl);
  }
}
type HealthAction = "개별 차단기" | "전체 차단기" | "세션 고정";
async function prepareHealth(page: Page, action: HealthAction) {
  const trigger =
    action === "개별 차단기"
      ? page
          .getByRole("table", { name: "공급자별 회로 차단기 상태" })
          .getByRole("button", { name: "해제", exact: true })
      : page.getByRole("button", {
          name: action === "전체 차단기" ? "전체 해제" : "세션 고정 전체 해제",
          exact: true,
        });
  await trigger.click();
  const dialog = page.getByRole("dialog", {
    name: action === "세션 고정" ? "세션 고정 해제" : "회로 차단기 해제",
    exact: true,
  });
  return {
    dialog,
    trigger,
    save: dialog.getByRole("button", { name: "해제", exact: true }),
    target: action === "개별 차단기" ? publicName : "",
    label: action === "개별 차단기" ? publicName : "전체 공급자",
    call: action === "세션 고정" ? "POST /admin/routing/balancer" : "POST /admin/routing/breaker-reset",
  };
}

for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`공급자 ${mode}는 기존 권한을 유지해도 모든 변경 진입을 막고 조회는 유지한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode("gateway.providers", mode);
    await login(page);
    await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeDisabled();
    for (const label of ["수정", "중지", "서비스 목표", "삭제"])
      await expect(publicRow(page).getByRole("button", { name: label, exact: true })).toBeDisabled();
    await publicRow(page).getByRole("link", { name: publicName, exact: true }).click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await page.keyboard.press("Escape");
    const count = gateway.reads.length;
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect.poll(() => gateway.reads.length).toBeGreaterThan(count);
    expect(gateway.writes).toEqual([]);
  });
  test(`상태 ${mode}는 routing:write가 있어도 운영 해제를 막고 실패 조회만 다시 시도한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode("gateway.health", mode);
    await login(page, healthUrl);
    for (const name of ["전체 해제", "세션 고정 전체 해제"])
      await expect(page.getByRole("button", { name, exact: true })).toBeDisabled();
    await expect(
      page
        .getByRole("table", { name: "공급자별 회로 차단기 상태" })
        .getByRole("button", { name: "해제", exact: true }),
    ).toBeDisabled();
    gateway.setRoutingStatus(503);
    await page.getByRole("button", { name: "새로고침", exact: true }).click();
    await expect(page.getByText("요청 ID: req-gateway-readonly", { exact: true })).toBeVisible();
    gateway.setRoutingStatus(200);
    await page.getByRole("button", { name: "공급자 라우팅 상태 재시도", exact: true }).click();
    await expect(page.getByText("요청 ID: req-gateway-readonly", { exact: true })).toBeHidden();
    expect(gateway.writes).toEqual([]);
  });
}
for (const action of ["추가", "편집", "검토", "중지", "삭제", "비공개 삭제", "SLO"] as const) {
  test(`공급자 ${action} 초안은 읽기 전용 전환에 보존·잠금되고 복구 뒤 수동 저장만 보낸다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action);
    await current.dialog.evaluate((element) => {
      (element as HTMLElement).dataset.draftIdentity = "original-instance";
    });
    gateway.setMode("gateway.providers", "read_only");
    await refreshRuntime(page);
    await expect(current.dialog).toHaveAttribute("data-draft-identity", "original-instance");
    await assertPreserved(current);
    await expect(current.dialog).toContainText(reason);
    await expect(current.save).toBeDisabled();
    await directSubmit(current.dialog);
    expect(gateway.writes).toEqual([]);
    gateway.setMode("gateway.providers", "writable");
    await refreshRuntime(page);
    await expect(current.save).toBeEnabled();
    expect(gateway.writes).toEqual([]);
    await finish(current);
    expect(gateway.writes.map(({ call }) => call)).toEqual([current.call]);
    if (action === "중지") {
      expect(gateway.writes[0]?.body).toMatchObject({ name: publicName, enabled: false });
      expect(gateway.writes[0]?.body).not.toHaveProperty("api_key");
    }
    if (action === "SLO")
      expect(gateway.writes[0]?.body).toMatchObject({ provider: publicName, note: draft });
  });
}
for (const mode of ["read_only", "preview_read_only"] as const) {
  for (const action of ["개별 차단기", "전체 차단기", "세션 고정"] as const) {
    test(`${action} 확인창 ${mode} 전환은 고정 대상을 보존하고 DOM 활성화 시도도 전송하지 않는다`, async ({
      page,
      gateway,
    }) => {
      await login(page, healthUrl);
      const current = await prepareHealth(page, action);
      await expect(current.save).toBeEnabled();
      gateway.setMode("gateway.health", mode);
      gateway.changeReadModels();
      await refreshRuntime(page);
      await refreshBehindModal(page, "gateway.health");
      await expect(current.dialog).toContainText(current.label);
      await expect(current.dialog).toContainText(reason);
      await expect(current.save).toBeDisabled();
      await forceConfirm(current.save);
      expect(gateway.writes).toEqual([]);
      gateway.setMode("gateway.health", "writable");
      await refreshRuntime(page);
      await expect(current.save).toBeEnabled();
      expect(gateway.writes).toEqual([]);
      await current.save.click();
      await expect(current.dialog).toBeHidden();
      expect(gateway.writes).toEqual([
        { call: current.call, body: { provider: current.target }, userId: "gateway-one" },
      ]);
    });
  }
}

for (const action of ["검토", "SLO"] as const) {
  test(`공급자 ${action} 기준은 읽기 전용 중 목록 갱신으로 바뀌지 않는다`, async ({ page, gateway }) => {
    await login(page);
    const current = await prepare(page, action);
    gateway.setMode("gateway.providers", "preview_read_only");
    gateway.changeReadModels();
    await refreshRuntime(page);
    await refreshBehindModal(page, "gateway.providers");
    await expect(current.save).toBeDisabled();
    await assertPreserved(current);
    if (action === "검토") {
      await expect(current.dialog).toContainText(originalUrl);
      await expect(current.dialog).not.toContainText("https://refreshed.example.invalid/v1");
    }
    gateway.setMode("gateway.providers", "writable");
    await refreshRuntime(page);
    await expect(current.save).toBeEnabled();
    await finish(current);
    expect(gateway.writes).toHaveLength(1);
    expect(gateway.writes[0]?.body).toMatchObject(
      action === "검토" ? { name: publicName, base_url: revisedUrl } : { provider: publicName, note: draft },
    );
  });
}
test("읽기 전용 검토에서도 영향 오류를 재조회할 수 있지만 갱신된 결과는 새 동의가 필요하다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const current = await prepare(page, "검토");
  gateway.setMode("gateway.providers", "read_only");
  await refreshRuntime(page);
  gateway.setImpactStatus(503);
  await current.dialog.getByRole("button", { name: "참조 영향 다시 조회", exact: true }).click();
  await expect(current.dialog).toContainText("req-gateway-readonly");
  await expect(consent(current.dialog)).not.toBeChecked();
  gateway.setImpactStatus(200);
  await current.dialog.getByRole("button", { name: "참조 영향 다시 조회", exact: true }).click();
  await expect(current.dialog).not.toContainText("req-gateway-readonly");
  await expect(current.save).toBeDisabled();
  expect(gateway.writes).toEqual([]);
  gateway.setMode("gateway.providers", "writable");
  await refreshRuntime(page);
  await expect(current.save).toBeDisabled();
  await acknowledge(current.dialog);
  await finish(current);
  expect(gateway.writes).toHaveLength(1);
});
for (const feature of ["gateway.providers", "gateway.health"] as const) {
  test(`${feature} readonly 복구는 기존 변경 scope를 새로 부여하지 않는다`, async ({ page, gateway }) => {
    await login(page, feature === "gateway.providers" ? providersUrl : healthUrl);
    gateway.setMode(feature, "read_only");
    gateway.setScope(feature === "gateway.providers" ? "admin:write" : "routing:write", false);
    await refreshRuntime(page);
    gateway.setMode(feature, "writable");
    await refreshRuntime(page);
    await expect(
      page.getByRole("button", {
        name: feature === "gateway.providers" ? "공급자 추가" : "전체 해제",
        exact: true,
      }),
    ).toBeDisabled();
    expect(gateway.writes).toEqual([]);
  });
}

for (const action of ["검토", "삭제", "SLO"] as const) {
  test(`이미 전송한 공급자 ${action}은 완료하되 읽기 전용 변경 버튼을 되살리지 않는다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action);
    gateway.hold("write");
    await current.save.click();
    await expect.poll(() => gateway.writes.length).toBe(1);
    gateway.setMode("gateway.providers", "preview_read_only");
    await refreshRuntime(page);
    await directSubmit(current.dialog);
    await page.keyboard.press("Escape");
    await expect(current.dialog).toBeVisible();
    expect(gateway.writes).toHaveLength(1);
    gateway.release("write");
    await expect(current.dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "공급자 추가", exact: true })).toBeDisabled();
    expect(gateway.writes).toHaveLength(1);
  });
}
test("이미 전송한 차단기 해제는 완료하되 readonly에서 새로운 해제를 허용하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page, healthUrl);
  const current = await prepareHealth(page, "개별 차단기");
  gateway.hold("write");
  await current.save.click();
  await expect.poll(() => gateway.writes.length).toBe(1);
  gateway.setMode("gateway.health", "read_only");
  await refreshRuntime(page);
  await page.keyboard.press("Escape");
  await expect(current.dialog).toBeVisible();
  gateway.release("write");
  await expect(current.dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "전체 해제", exact: true })).toBeDisabled();
  expect(gateway.writes).toHaveLength(1);
});
for (const kind of ["공급자", "차단기"] as const) {
  test(`${kind} 실패의 요청 ID와 대상은 readonly 중에도 남고 복구 뒤 수동 재시도만 허용된다`, async ({
    page,
    gateway,
  }) => {
    const feature: Feature = kind === "공급자" ? "gateway.providers" : "gateway.health";
    await login(page, kind === "공급자" ? providersUrl : healthUrl);
    const current =
      kind === "공급자" ? await prepare(page, "검토") : await prepareHealth(page, "개별 차단기");
    gateway.setWriteStatus(503);
    await current.save.click();
    await expect(current.dialog.getByRole("alert")).toContainText("req-gateway-readonly");
    gateway.setMode(feature, "read_only");
    await refreshRuntime(page);
    await expect(current.save).toBeDisabled();
    await expect(current.dialog.getByRole("alert")).toContainText("req-gateway-readonly");
    if (kind === "공급자") await directSubmit(current.dialog);
    else await forceConfirm(current.save);
    expect(gateway.writes).toHaveLength(1);
    gateway.setWriteStatus(200);
    gateway.setMode(feature, "writable");
    await refreshRuntime(page);
    if (kind === "공급자") {
      // Leaving pending reenables the stale impact query. Its new response
      // requires fresh explicit consent; readonly recovery cannot grant it.
      await expect(consent(current.dialog)).not.toBeChecked();
      await expect(current.save).toBeDisabled();
      expect(gateway.writes).toHaveLength(1);
      await acknowledge(current.dialog);
    }
    await expect(current.save).toBeEnabled();
    expect(gateway.writes).toHaveLength(1);
    await current.save.click();
    await expect(current.dialog).toBeHidden();
    expect(gateway.writes).toHaveLength(2);
  });
}
for (const kind of ["공급자", "차단기"] as const) {
  for (const status of [200, 503]) {
    test(`${kind} 이전 세션의 늦은 ${status}는 새 계정 readonly 화면과 알림을 변경하지 않는다`, async ({
      page,
      context,
      gateway,
    }) => {
      const feature: Feature = kind === "공급자" ? "gateway.providers" : "gateway.health",
        path = kind === "공급자" ? providersUrl : healthUrl;
      await login(page, path);
      const other = await context.newPage();
      await login(other, path);
      const current =
        kind === "공급자" ? await prepare(page, "검토") : await prepareHealth(page, "개별 차단기");
      gateway.setWriteStatus(status);
      gateway.hold("write");
      await current.save.click();
      await expect.poll(() => gateway.writes.length).toBe(1);
      await other.getByLabel("사용자 메뉴").click();
      await other.getByRole("button", { name: "로그아웃", exact: true }).click();
      gateway.setMode(feature, "read_only");
      await signIn(page, secondEmail);
      const response = page.waitForResponse(
        (item) => `${item.request().method()} ${new URL(item.url()).pathname}` === current.call,
      );
      gateway.release("write");
      await (await response).finished();
      await page.waitForTimeout(500);
      await expect(current.dialog).toBeHidden();
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: kind === "공급자" ? "공급자 추가" : "전체 해제", exact: true }),
      ).toBeDisabled();
      expect(gateway.writes).toHaveLength(1);
    });
  }
}
async function safeMainFocus(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const active = document.activeElement;
        return (
          active instanceof HTMLElement &&
          active.id === "main-content" &&
          active.isConnected &&
          active.getClientRects().length > 0
        );
      }),
    )
    .toBe(true);
}
for (const action of ["추가", "검토", "SLO"] as const) {
  test(`readonly 공급자 ${action}도 계속 편집과 명시적 폐기가 가능하고 안전한 곳으로 포커스를 복원한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    const current = await prepare(page, action);
    gateway.setMode("gateway.providers", "read_only");
    await refreshRuntime(page);
    await page.keyboard.press("Escape");
    await guard(page).getByRole("button", { name: "계속 편집", exact: true }).click();
    await assertPreserved(current);
    await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
    await guard(page).getByRole("button", { name: "변경 버리기", exact: true }).click();
    await expect(current.dialog).toBeHidden();
    await safeMainFocus(page);
    expect(gateway.writes).toEqual([]);
  });
}
test("readonly 상태 확인창 취소는 요청 없이 비활성 trigger 대신 안전한 포커스로 돌아간다", async ({
  page,
  gateway,
}) => {
  await login(page, healthUrl);
  const current = await prepareHealth(page, "개별 차단기");
  gateway.setMode("gateway.health", "read_only");
  await refreshRuntime(page);
  await expect(current.save).toBeDisabled();
  await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(current.dialog).toBeHidden();
  await safeMainFocus(page);
  expect(gateway.writes).toEqual([]);
});

async function accessibleMobile(page: Page, dialog: Locator) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  const violations = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await api.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
  expect(violations).toEqual([]);
}
for (const kind of ["공급자 검토", "비공개 삭제", "차단기"] as const) {
  test(`390px 다크 ${kind} 읽기 전용 안내와 닫기는 axe·넘침·포커스를 지킨다`, async ({
    page,
    gateway,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
    await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
    await login(page, kind === "차단기" ? healthUrl : providersUrl);
    const current =
      kind === "차단기"
        ? await prepareHealth(page, "개별 차단기")
        : await prepare(page, kind === "비공개 삭제" ? "비공개 삭제" : "검토");
    gateway.setMode(kind === "차단기" ? "gateway.health" : "gateway.providers", "preview_read_only");
    await refreshRuntime(page);
    await expect(current.save).toBeDisabled();
    await expect(current.dialog).toContainText(reason);
    await accessibleMobile(page, current.dialog);
    await page.screenshot({ path: info.outputPath(`gateway-readonly-${kind}-mobile-dark.png`) });
    const notice = current.dialog.getByText(reason, { exact: true });
    await notice.scrollIntoViewIfNeeded();
    await expect(notice).toBeInViewport();
    await expect(current.save).toBeInViewport();
    await accessibleMobile(page, current.dialog);
    await page.screenshot({ path: info.outputPath(`gateway-readonly-${kind}-notice-mobile-dark.png`) });
    await current.dialog.getByRole("button", { name: "취소", exact: true }).click();
    if (kind === "공급자 검토") {
      await accessibleMobile(page, guard(page));
      await guard(page).getByRole("button", { name: "변경 버리기", exact: true }).click();
    }
    await expect(current.dialog).toBeHidden();
    await safeMainFocus(page);
    expect(gateway.writes).toEqual([]);
  });
}
