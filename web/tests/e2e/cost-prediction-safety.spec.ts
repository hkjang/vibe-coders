import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type CostGateway,
  predictionUrl,
  estimateResult,
  publicModel,
  firstEmail,
  secondEmail,
  requestId,
} from "../fixtures/cost-prediction-safety-gateway";

// Real React/router/input events against synthetic HTTP only. Captured callback
// admission, actual Go pricing/auth and controlled JS finally races are separate.
const card = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: "비용 예측 가드", exact: true }),
  });
const execute = (page: Page) => card(page).getByRole("button", { name: /^(비용 예측|계산 중)$/u });
const modelInput = (page: Page) => card(page).getByRole("textbox", { name: "모델", exact: true });
const inputTokens = (page: Page) => card(page).getByRole("spinbutton", { name: "입력 토큰", exact: true });
const maxTokens = (page: Page) => card(page).getByRole("spinbutton", { name: "최대 출력 토큰", exact: true });
const definition = (page: Page, label: string) =>
  card(page)
    .locator(".kv-item")
    .filter({
      has: page.getByText(label, { exact: true }),
    })
    .locator("dd");
const resultModel = (page: Page) => definition(page, "모델");
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  await expect(card(page)).toBeVisible();
}
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(predictionUrl)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function fields(page: Page, model = publicModel, input = "1000", max = "600") {
  await modelInput(page).fill(model);
  await inputTokens(page).fill(input);
  await maxTokens(page).fill(max);
}
async function runtime(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function release(gateway: CostGateway, sequence: number) {
  gateway.release(sequence);
  await expect.poll(() => gateway.finished.has(sequence)).toBe(true);
}
async function settleBrowser(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
async function blockedPhysicalClick(page: Page, button: Locator) {
  await expect(button).toBeDisabled();
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport({ ratio: 1 });
  await button.evaluate((node) => {
    node.setAttribute("data-native-clicks", "0");
    node.addEventListener("click", () =>
      node.setAttribute("data-native-clicks", String(Number(node.getAttribute("data-native-clicks")) + 1)),
    );
  });
  const bounds = await button.boundingBox();
  if (!bounds) throw new Error("Missing disabled prediction control bounds");
  expect(
    await button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === node || (hit !== null && node.contains(hit));
    }),
  ).toBe(true);
  await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(button).toHaveAttribute("data-native-clicks", "0");
  // Native disabled rejection is not proof of entry to a React callback.
}
async function unchangedGuard(page: Page) {
  await expect(definition(page, "예상 비용 보호")).toHaveText("제한 없음");
  await expect(definition(page, "요청당 임계값")).toHaveText(/0/u);
}
for (const mode of ["writable", "read_only", "preview_read_only"] as const) {
  test(`${mode}: admin:write가 있으면 routing:write 없이 계산만 한 번 전송한다`, async ({
    page,
    gateway,
  }) => {
    gateway.setMode(mode);
    await login(page);
    await unchangedGuard(page);
    await fields(page, `  ${publicModel}  `);
    await execute(page).click();
    await expect(resultModel(page)).toHaveText(publicModel);
    await expect(definition(page, "계산한 모델")).toHaveText(publicModel);
    expect(gateway.operations).toEqual([
      {
        sequence: 1,
        userId: "cost-one",
        body: { model: publicModel, input_tokens: 1000, max_tokens: 600 },
      },
    ]);
    expect(gateway.guardReads()).toBeGreaterThan(0);
    // Unexpected calls fail teardown, including /v1, CRUD and cost-guard writes.
  });
}
for (const timing of ["pending", "complete"] as const) {
  test(`${timing}: A 계산과 B 입력을 구분하고 모델·토큰은 수동 재실행 때만 바뀐다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await fields(page);
    gateway.plan(1, { hold: true });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(1);
    if (timing === "complete") {
      await release(gateway, 1);
      await expect(resultModel(page)).toHaveText(publicModel);
    }
    await fields(page, "public-next-cost-model", "2000", "900");
    if (timing === "pending") await release(gateway, 1);
    await expect(resultModel(page)).toHaveText(publicModel);
    await expect(definition(page, "계산한 모델")).toHaveText(publicModel);
    await expect(definition(page, "계산한 입력 토큰")).toHaveText(/1,?000/u);
    await expect(definition(page, "계산한 최대 출력 토큰")).toHaveText("600");
    await expect(card(page).getByText(/입력이 달라졌습니다/u)).toBeVisible();
    await expect(modelInput(page)).toHaveValue("public-next-cost-model");
    await expect(inputTokens(page)).toHaveValue("2000");
    await expect(maxTokens(page)).toHaveValue("900");
    expect(gateway.count()).toBe(1);
    await execute(page).click();
    await expect(resultModel(page)).toHaveText("public-next-cost-model");
    await expect(definition(page, "계산한 입력 토큰")).toHaveText(/2,?000/u);
    await expect(definition(page, "계산한 최대 출력 토큰")).toHaveText("900");
    await expect(card(page).getByText(/입력이 달라졌습니다/u)).toHaveCount(0);
    expect(gateway.operations.map(({ body }) => body)).toEqual([
      { model: publicModel, input_tokens: 1000, max_tokens: 600 },
      { model: "public-next-cost-model", input_tokens: 2000, max_tokens: 900 },
    ]);
  });
}
for (const [basis, korean] of [
  ["history", "과거 사용량 기준"],
  ["max_tokens", "입력한 출력 토큰 기준"],
  ["default", "기본 출력 토큰 기준"],
] as const) {
  test(`${basis}: 한글 계산 기준과 과거 측정이 없는 지연 0을 구분한다`, async ({ page, gateway }) => {
    await login(page);
    const max = basis === "default" ? "0" : "100";
    await fields(page, publicModel, "1000", max);
    gateway.plan(1, {
      result: {
        ...estimateResult(),
        basis,
        output_tokens: basis === "max_tokens" ? 100 : 600,
        latency_ms: basis === "history" ? 40 : 0,
      },
    });
    await execute(page).click();
    await expect(definition(page, "산정 기준")).toHaveText(korean);
    await expect(definition(page, "예상 지연")).toHaveText(
      basis === "history" ? /40\s*ms/u : /확인할 수 없음/u,
    );
    await expect(definition(page, "예상 출력 토큰")).toHaveText(basis === "max_tokens" ? "100" : "600");
    expect(gateway.count()).toBe(1);
    // These are faithful response projections, not actual history/pricing runs.
    // History can exceed request max_tokens; it is not a hard output cap.
  });
}
test("가격 미확인의 비용 0과 가격이 적용된 0을 구분한다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { result: { ...estimateResult(), priced: false, cost_krw: 0 } });
  await execute(page).click();
  await expect(definition(page, "가격표 적용")).toHaveText("가격 정보 미확인");
  await expect(definition(page, "예상 비용")).toHaveText("확인할 수 없음");
  gateway.plan(2, { result: { ...estimateResult(), priced: true, cost_krw: 0 } });
  await execute(page).click();
  await expect(definition(page, "가격표 적용")).toHaveText("추정 가능");
  await expect(definition(page, "예상 비용")).toHaveText(/0/u);
  await expect(definition(page, "예상 비용")).not.toHaveText(/확인할 수 없음/u);
  expect(gateway.count()).toBe(2);
  // priced:true can include fallback pricing; no exact-price-source assertion.
});
for (const [field, invalid] of [
  ["input", "-1"],
  ["max", "1.5"],
  ["input", "9007199254740992"],
] as const) {
  test(`${field}=${invalid}: 첫 실제 클릭은 오류 입력으로 초점을 옮기고 교정 후에만 전송한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await fields(page, publicModel, field === "input" ? invalid : "1000", field === "max" ? invalid : "600");
    const invalidInput = field === "input" ? inputTokens(page) : maxTokens(page);
    await expect(invalidInput).toHaveValue(invalid);
    const button = execute(page),
      exactButton = await button.elementHandle();
    if (!exactButton) throw new Error("Missing prediction control");
    await button.evaluate((node) => {
      node.setAttribute("data-native-start", "0");
      node.addEventListener("click", () =>
        node.setAttribute("data-native-start", String(Number(node.getAttribute("data-native-start")) + 1)),
      );
    });
    await button.click();
    await expect.poll(() => exactButton.getAttribute("data-native-start")).toBe("1");
    await expect(invalidInput).toHaveAttribute("aria-invalid", "true");
    await expect(invalidInput).toBeFocused();
    expect(gateway.count()).toBe(0);
    await invalidInput.fill(field === "input" ? "1000" : "600");
    await execute(page).click();
    await expect(resultModel(page)).toHaveText(publicModel);
    expect(gateway.operations.map(({ body }) => body)).toEqual([
      { model: publicModel, input_tokens: 1000, max_tokens: 600 },
    ]);
  });
}
test("빈 토큰과 명시적 0은 기존 본문 0을 보존하며 자동 실행하지 않는다", async ({ page, gateway }) => {
  await login(page);
  await fields(page, publicModel, "", "");
  await expect(inputTokens(page)).toHaveValue("");
  await expect(maxTokens(page)).toHaveValue("");
  await expect(card(page).getByText(/비우면 입력 토큰 0/u)).toBeVisible();
  expect(gateway.count()).toBe(0);
  await execute(page).click();
  await expect(resultModel(page)).toHaveText(publicModel);
  await fields(page, publicModel, "0", "0");
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(2);
  expect(gateway.operations.map(({ body }) => body)).toEqual([
    { model: publicModel, input_tokens: 0, max_tokens: 0 },
    { model: publicModel, input_tokens: 0, max_tokens: 0 },
  ]);
  // This proves request compatibility, not a forced 600-token backend estimate:
  // eligible history takes precedence over the default output estimate.
});
test("admin:write 회수 중 완료한 결과는 게시하지 않고 입력 보존·복구 후 수동 실행만 허용한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { hold: true });
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(1);
  gateway.setGrants({ adminWrite: false });
  await runtime(page);
  await expect(modelInput(page)).toHaveValue(publicModel);
  await blockedPhysicalClick(page, execute(page));
  await release(gateway, 1);
  await expect(card(page).getByText("이전 계산 결과를 표시하지 않습니다.", { exact: true })).toBeVisible();
  await expect(resultModel(page)).toHaveCount(0);
  await expect(definition(page, "계산한 모델")).toHaveText(publicModel);
  expect(gateway.count()).toBe(1);
  gateway.setGrants({ adminWrite: true });
  await runtime(page);
  await expect(execute(page)).toBeEnabled();
  await expect(resultModel(page)).toHaveCount(0);
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect(resultModel(page)).toHaveText(publicModel);
  expect(gateway.count()).toBe(2);
});
test("routing:read 회수로 닫힌 화면은 보류 결과를 버리고 복구해도 자동 계산하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { hold: true });
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(1);
  gateway.setGrants({ routingRead: false });
  await runtime(page);
  await expect(card(page)).toHaveCount(0);
  await release(gateway, 1);
  await settleBrowser(page);
  gateway.setGrants({ routingRead: true });
  await runtime(page);
  await expect(card(page)).toBeVisible();
  await expect(resultModel(page)).toHaveCount(0);
  expect(gateway.count()).toBe(1);
  await fields(page, "public-restored-model");
  await execute(page).click();
  await expect(resultModel(page)).toHaveText("public-restored-model");
  expect(gateway.count()).toBe(2);
});
test("실제 탭 이동 뒤 늦은 응답은 새 입력이나 오류 영역을 덮지 않는다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { hold: true });
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(1);
  await page.getByRole("tab", { name: "라우팅 규칙", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "미리보기", exact: true }).click();
  await fields(page, "public-new-tab-model");
  await release(gateway, 1);
  await settleBrowser(page);
  await expect(resultModel(page)).toHaveCount(0);
  await expect(modelInput(page)).toHaveValue("public-new-tab-model");
  await expect(card(page).getByRole("alert")).toHaveCount(0);
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect(resultModel(page)).toHaveText("public-new-tab-model");
  expect(gateway.count()).toBe(2);
});
for (const status of [200, 503]) {
  test(`다른 탭 로그아웃 뒤 이전 ${status}가 새 계정의 보류 요청과 겹쳐도 진행 상태를 보존한다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    await page.evaluate(() => {
      (window as Window & { costMarker?: string }).costMarker = "public-same-document";
    });
    await fields(page);
    gateway.plan(1, { hold: true, status });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    expect(await page.evaluate(() => (window as Window & { costMarker?: string }).costMarker)).toBe(
      "public-same-document",
    );
    await expect(modelInput(page)).toHaveValue("");
    await fields(page, "public-second-account", "2000", "900");
    gateway.plan(2, { hold: true });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(2);
    expect([...gateway.finished]).toEqual([]);
    await release(gateway, 1);
    await settleBrowser(page);
    await expect(execute(page)).toHaveText("계산 중");
    await expect(execute(page)).toBeDisabled();
    await expect(modelInput(page)).toHaveValue("public-second-account");
    await expect(resultModel(page)).toHaveCount(0);
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.finished.has(2)).toBe(false);
    await blockedPhysicalClick(page, execute(page));
    expect(gateway.count()).toBe(2);
    await release(gateway, 2);
    await expect(resultModel(page)).toHaveText("public-second-account");
    await expect(execute(page)).toBeEnabled();
    expect(gateway.operations.map(({ userId }) => userId)).toEqual(["cost-one", "cost-two"]);
    // Held HTTP attempts overlap. Browser abort may settle old JS early; this
    // is not exact old-finally/new-flight ordering (covered by local units).
    await other.close();
  });
}
test("빈 모델과 진행 중 실제 포인터·키보드 동작은 중복 전송하지 않는다", async ({ page, gateway }) => {
  await login(page);
  await blockedPhysicalClick(page, execute(page));
  expect(gateway.count()).toBe(0);
  await fields(page);
  gateway.plan(1, { hold: true });
  const button = execute(page),
    exactButton = await button.elementHandle();
  if (!exactButton) throw new Error("Missing execution control");
  await button.evaluate((node) => {
    node.setAttribute("data-native-start", "0");
    node.addEventListener("click", () =>
      node.setAttribute("data-native-start", String(Number(node.getAttribute("data-native-start")) + 1)),
    );
  });
  await button.click();
  await expect.poll(() => exactButton.getAttribute("data-native-start")).toBe("1");
  await expect.poll(() => gateway.count()).toBe(1);
  await modelInput(page).click();
  await page.keyboard.press("Enter");
  await blockedPhysicalClick(page, execute(page));
  expect(gateway.count()).toBe(1);
  await release(gateway, 1);
  await expect(resultModel(page)).toHaveText(publicModel);
});
test("503 오류는 한글 안내·요청 ID·입력을 유지하고 수동 재시도만 허용한다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { status: 503 });
  await execute(page).click();
  await expect(
    card(page)
      .getByText(/비용을 예측하지 못했습니다/u)
      .first(),
  ).toBeVisible();
  await expect(card(page).getByText(new RegExp(requestId, "u"))).toBeVisible();
  await expect(modelInput(page)).toHaveValue(publicModel);
  await expect(inputTokens(page)).toHaveValue("1000");
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect(resultModel(page)).toHaveText(publicModel);
  expect(gateway.count()).toBe(2);
});
test("현재 접두사 변경은 새 결과·기준의 원문만 가리고 원본 입력·전송을 변경하지 않는다", async ({
  page,
  gateway,
}) => {
  const marker = `late_cost_${"b".repeat(40)}`;
  await login(page);
  await fields(page, marker);
  gateway.plan(1, { result: { ...estimateResult(marker), basis: marker } });
  await execute(page).click();
  await expect(resultModel(page)).toHaveText(marker);
  gateway.setPrefixes(["late_cost_"]);
  await runtime(page);
  await expect(resultModel(page)).not.toHaveText(marker);
  await expect(definition(page, "계산한 모델")).not.toHaveText(marker);
  await expect(definition(page, "산정 기준")).not.toHaveText(marker);
  await expect(modelInput(page)).toHaveValue(marker);
  const display = await card(page).evaluate((node) => {
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input, textarea").forEach((control) => control.remove());
    return copy.outerHTML;
  });
  expect(display).not.toContain(marker);
  expect(
    await page.evaluate(
      (value) =>
        [location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })].some(
          (stored) => [value, encodeURIComponent(value)].some((candidate) => stored.includes(candidate)),
        ),
      marker,
    ),
  ).toBe(false);
  expect(gateway.operations[0]?.body.model).toBe(marker);
  expect(gateway.count()).toBe(1);
  // Display-only masking: no server/proxy/browser-memory secrecy guarantee.
});
test("오류 요청 ID도 현재 런타임 접두사에 따라 표시 전용으로 가린다", async ({ page, gateway }) => {
  const marker = `custom_cost_${"c".repeat(40)}`;
  gateway.setPrefixes(["custom_cost_"]);
  await login(page);
  await fields(page);
  gateway.plan(1, { status: 503, requestId: marker });
  await execute(page).click();
  await expect(
    card(page)
      .getByText(/비용을 예측하지 못했습니다/u)
      .first(),
  ).toBeVisible();
  expect(await card(page).innerText()).not.toContain(marker);
  expect(await card(page).evaluate((node) => node.outerHTML)).not.toContain(marker);
  expect(gateway.count()).toBe(1);
});
test("별도 admin:read 없는 조회401·한 번의 갱신 후에도 admin:write 계산을 막지 않는다", async ({
  page,
  gateway,
}) => {
  gateway.setGrants({ adminRead: false });
  await login(page);
  await expect(definition(page, "예상 비용 보호")).toHaveText("설정 미확인");
  await expect(definition(page, "요청당 임계값")).toHaveText("확인되지 않음");
  await expect.poll(() => gateway.guardReads()).toBe(2);
  expect(gateway.refreshes()).toBe(1);
  await fields(page);
  await execute(page).click();
  await expect(resultModel(page)).toHaveText(publicModel);
  expect(gateway.count()).toBe(1);
  expect(gateway.guardReads()).toBe(2);
  expect(gateway.refreshes()).toBe(1);
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  // This fixture separates GET admin:read and POST admin:write; it is not
  // actual Go auth proof. The real client refreshes once after GET401, then
  // preserves the session on the retried401 because refresh itself succeeded.
});
async function axe(page: Page) {
  return page.evaluate(async () => {
    const engine = (
      window as Window & {
        axe?: {
          run: (root: Document) => Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }>;
        };
      }
    ).axe;
    if (!engine) throw new Error("Accessibility engine missing");
    return (await engine.run(document)).violations.map(({ id, nodes }) => ({
      id,
      targets: nodes.map(({ target }) => target),
    }));
  });
}
async function noOverflow(page: Page) {
  expect(await page.evaluate(() => document.body.scrollWidth <= innerWidth)).toBe(true);
  expect(await card(page).evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const value of await card(page).locator("dd").all())
    expect(await value.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
}
test("390px 다크 화면은 키보드 계산·한글 기준·긴 모델 줄바꿈과 접근성을 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  gateway.setMode("preview_read_only");
  await login(page);
  const longModel = `public-${"긴계산모델".repeat(32)}`;
  await fields(page, longModel);
  gateway.plan(1, { hold: true, result: estimateResult(longModel) });
  // Preserve the existing summary refresh button's keyboard order and reach
  // the primary action with actual keys, not script focus or synthetic events.
  await modelInput(page).click();
  await page.keyboard.press("Shift+Tab");
  await expect(
    card(page).getByRole("button", { name: "비용 보호 설정 새로고침", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(execute(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.count()).toBe(1);
  await expect(execute(page)).toBeDisabled();
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await release(gateway, 1);
  await expect(resultModel(page)).toHaveText(longModel);
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await definition(page, "계산한 모델").scrollIntoViewIfNeeded();
  await expect(definition(page, "계산한 모델")).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("cost-prediction-result-explicit-scroll.png") });
  await fields(page, "public-mobile-next", "2000", "900");
  const changed = card(page).getByText(/입력이 달라졌습니다/u);
  await changed.scrollIntoViewIfNeeded();
  await expect(changed).toBeInViewport({ ratio: 1 });
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("cost-prediction-changed-explicit-scroll.png") });
  expect(gateway.count()).toBe(1);
  // These are explicitly scrolled views, not automatic/sticky visibility proof.
});
