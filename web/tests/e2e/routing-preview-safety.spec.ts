import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  type PreviewGateway,
  previewUrl,
  previewResult,
  publicModel,
  sampleA,
  sampleB,
  firstEmail,
  secondEmail,
  requestId,
} from "../fixtures/routing-preview-safety-gateway";

// Real React/router/browser events against synthetic HTTP. No captured React
// callback, actual Go, provider execution or server confidentiality proof here.
const card = (page: Page) =>
  page.locator("section").filter({
    has: page.getByRole("heading", { name: "라우팅 미리보기", exact: true }),
  });
const execute = (page: Page) => card(page).getByRole("button", { name: /^(미리보기 실행|확인 중)$/u });
const modelInput = (page: Page) => card(page).getByRole("textbox", { name: "요청 모델", exact: true });
const sampleInput = (page: Page) => card(page).getByRole("textbox", { name: "샘플 요청 내용", exact: true });
const keyInput = (page: Page) => card(page).getByRole("textbox", { name: "정책 API 키 ID", exact: true });
const selected = (page: Page, model = publicModel) =>
  card(page).getByText(`${model}-selected`, { exact: true });
const definition = (page: Page, label: string) =>
  card(page)
    .locator(".kv-item")
    .filter({ has: page.getByText(label, { exact: true }) })
    .locator("dd");
async function signIn(page: Page, email = firstEmail) {
  await expect(page.getByRole("heading", { name: "관리자 로그인", exact: true })).toBeVisible();
  await page.getByLabel("이메일", { exact: true }).fill(email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByLabel("사용자 메뉴")).toBeVisible();
  await expect(card(page)).toBeVisible();
}
async function login(page: Page) {
  await page.goto(`login?return_to=${encodeURIComponent(previewUrl)}`);
  await signIn(page);
  const interval = page.getByLabel("자동 새로고침 간격");
  if (await interval.isVisible()) await interval.selectOption("0");
}
async function fields(page: Page, model = publicModel, sample = sampleA, keyId = "") {
  await modelInput(page).fill(model);
  await sampleInput(page).fill(sample);
  await keyInput(page).fill(keyId);
}
async function runtime(page: Page) {
  const response = page.waitForResponse((value) => new URL(value.url()).pathname === "/admin/ui-bootstrap");
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await (await response).finished();
}
async function release(gateway: PreviewGateway, sequence: number) {
  gateway.release(sequence);
  await expect.poll(() => gateway.finished.has(sequence)).toBe(true);
}
async function settleBrowser(page: Page) {
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
}
async function nonInputText(page: Page) {
  return card(page).evaluate((node) => {
    // Inspect a detached copy only: the editable sample is expected to contain
    // its original value, but no other card content may duplicate it.
    const copy = node.cloneNode(true) as HTMLElement;
    copy.querySelectorAll("input, textarea").forEach((control) => control.remove());
    return copy.textContent ?? "";
  });
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
  const box = await button.boundingBox();
  if (!box) throw new Error("Missing disabled button bounds");
  expect(
    await button.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === node || (hit !== null && node.contains(hit));
    }),
  ).toBe(true);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect(button).toHaveAttribute("data-native-clicks", "0");
  // A disabled native click does not prove entry to a captured React callback.
}

for (const mode of ["writable", "read_only", "preview_read_only"] as const) {
  test(`${mode}: routing:read만으로 실제 버튼은 계획 POST 1회만 보낸다`, async ({ page, gateway }) => {
    gateway.setMode(mode);
    await login(page);
    await fields(page, publicModel, sampleA, "key_public_a");
    await execute(page).click();
    await expect(selected(page)).toBeVisible();
    await expect(definition(page, "계산한 요청 모델")).toHaveText(publicModel);
    await expect(definition(page, "계산한 키 정책")).toHaveText("key_public_a");
    expect(gateway.operations).toEqual([
      {
        sequence: 1,
        userId: "preview-one",
        body: {
          model: publicModel,
          messages: [{ role: "user", content: sampleA }],
          api_key_id: "key_public_a",
        },
      },
    ]);
    await expect(page.getByRole("button", { name: "비용 예측", exact: true })).toBeDisabled();
  });
}
for (const mode of ["read_only", "preview_read_only"] as const) {
  test(`전송 중 ${mode} 전환도 순수 계획 결과를 허용하고 입력을 보존한다`, async ({ page, gateway }) => {
    await login(page);
    await fields(page);
    gateway.plan(1, { hold: true });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(1);
    gateway.setMode(mode);
    await runtime(page);
    await expect(execute(page)).toBeDisabled();
    await expect(sampleInput(page)).toHaveValue(sampleA);
    await release(gateway, 1);
    await expect(selected(page)).toBeVisible();
    await expect(execute(page)).toBeEnabled();
    expect(gateway.count()).toBe(1);
  });
}
for (const timing of ["pending", "complete"] as const) {
  test(`${timing}: A 계산 후 B 편집은 실행 기준을 바꾸지 않고 수동 재실행만 B를 전송한다`, async ({
    page,
    gateway,
  }) => {
    await login(page);
    await fields(page, publicModel, sampleA, "key_public_a");
    gateway.plan(1, { hold: true });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(1);
    if (timing === "complete") {
      await release(gateway, 1);
      await expect(selected(page)).toBeVisible();
    }
    await fields(page, "public-next-model", sampleB, "key_public_b");
    if (timing === "pending") await release(gateway, 1);
    await expect(selected(page)).toBeVisible();
    await expect(card(page).getByText(/입력이 달라졌습니다/u)).toBeVisible();
    await expect(definition(page, "계산한 요청 모델")).toHaveText(publicModel);
    await expect(definition(page, "계산한 키 정책")).toHaveText("key_public_a");
    await expect(modelInput(page)).toHaveValue("public-next-model");
    await expect(sampleInput(page)).toHaveValue(sampleB);
    expect(gateway.count()).toBe(1);
    expect((await card(page).locator("dl").allTextContents()).join(" ")).not.toContain(sampleA);
    await execute(page).click();
    await expect(selected(page, "public-next-model")).toBeVisible();
    await expect(definition(page, "계산한 요청 모델")).toHaveText("public-next-model");
    await expect(definition(page, "계산한 키 정책")).toHaveText("key_public_b");
    await expect(selected(page)).toHaveCount(0);
    await expect(card(page).getByText(/입력이 달라졌습니다/u)).toHaveCount(0);
    expect(gateway.operations.map(({ body }) => body)).toEqual([
      { model: publicModel, messages: [{ role: "user", content: sampleA }], api_key_id: "key_public_a" },
      {
        model: "public-next-model",
        messages: [{ role: "user", content: sampleB }],
        api_key_id: "key_public_b",
      },
    ]);
  });
}
for (const variant of ["default", "runtime", "encoded-runtime"] as const) {
  test(`${variant}: 키 ID의 비밀 형태는 실제 포인터 입력으로도 POST 0이고 교정 후 수동 1이다`, async ({
    page,
    gateway,
  }) => {
    const prefix = variant === "default" ? "vc_sk_" : "custom_preview_";
    const raw = `${prefix}${"a".repeat(40)}`;
    const value =
      variant === "encoded-runtime"
        ? [...raw].map((char) => `%${char.charCodeAt(0).toString(16)}`).join("")
        : raw;
    if (variant !== "default") gateway.setPrefixes([prefix]);
    await login(page);
    await fields(page, publicModel, sampleA, value);
    await expect(keyInput(page)).toHaveAttribute("aria-invalid", "true");
    await blockedPhysicalClick(page, execute(page));
    expect(gateway.count()).toBe(0);
    await keyInput(page).fill("key_public_corrected");
    await execute(page).click();
    await expect(selected(page)).toBeVisible();
    expect(gateway.operations[0]?.body.api_key_id).toBe("key_public_corrected");
    expect(gateway.count()).toBe(1);
  });
}
test("열린 입력의 런타임 접두사 변경은 값을 보존하면서 전송을 막고 교정 뒤 수동 실행한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const keyId = `late_preview_${"c".repeat(40)}`;
  await fields(page, publicModel, sampleA, keyId);
  await expect(execute(page)).toBeEnabled();
  gateway.setPrefixes(["late_preview_"]);
  await runtime(page);
  await expect(keyInput(page)).toHaveValue(keyId);
  await expect(keyInput(page)).toHaveAttribute("aria-invalid", "true");
  await blockedPhysicalClick(page, execute(page));
  expect(gateway.count()).toBe(0);
  await keyInput(page).fill("key_public_recovered");
  await execute(page).click();
  await expect(selected(page)).toBeVisible();
  expect(gateway.operations[0]?.body.api_key_id).toBe("key_public_recovered");
  expect(gateway.count()).toBe(1);
});
test("조회 권한 회수는 현재 결과를 폐기하고 복구 뒤 수동 계산만 허용한다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { hold: true });
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(1);
  gateway.setRead(false);
  await runtime(page);
  await expect(card(page)).toHaveCount(0);
  await release(gateway, 1);
  await settleBrowser(page);
  expect(gateway.count()).toBe(1);
  gateway.setRead(true);
  await runtime(page);
  await expect(card(page)).toBeVisible();
  await expect(selected(page)).toHaveCount(0);
  await fields(page, "public-restored-model", sampleB);
  await execute(page).click();
  await expect(selected(page, "public-restored-model")).toBeVisible();
  expect(gateway.count()).toBe(2);
});
test("실제 라우팅 탭 이동 후 돌아오면 이전 보류 결과가 새 입력에 붙지 않는다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { hold: true });
  await execute(page).click();
  await expect.poll(() => gateway.count()).toBe(1);
  await page.getByRole("tab", { name: "라우팅 규칙", exact: true }).click();
  await expect(card(page)).toHaveCount(0);
  await page.getByRole("tab", { name: "미리보기", exact: true }).click();
  await fields(page, "public-new-tab-model", sampleB);
  await release(gateway, 1);
  await settleBrowser(page);
  await expect(selected(page)).toHaveCount(0);
  await expect(sampleInput(page)).toHaveValue(sampleB);
  await expect(card(page).getByRole("alert")).toHaveCount(0);
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect(selected(page, "public-new-tab-model")).toBeVisible();
  expect(gateway.count()).toBe(2);
});
for (const status of [200, 503]) {
  test(`이전 세션 ${status}와 새 세션의 보류 전송이 겹쳐도 현재 진행 상태·결과를 보존한다`, async ({
    page,
    context,
    gateway,
  }) => {
    await login(page);
    const other = await context.newPage();
    await login(other);
    await page.evaluate(() => {
      (window as Window & { previewMarker?: string }).previewMarker = "public-same-document";
    });
    await fields(page);
    gateway.plan(1, { hold: true, status });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(1);
    await other.getByLabel("사용자 메뉴").click();
    await other.getByRole("button", { name: "로그아웃", exact: true }).click();
    await signIn(page, secondEmail);
    expect(await page.evaluate(() => (window as Window & { previewMarker?: string }).previewMarker)).toBe(
      "public-same-document",
    );
    await expect(sampleInput(page)).toHaveValue("");
    await fields(page, "public-second-account", sampleB);
    gateway.plan(2, { hold: true });
    await execute(page).click();
    await expect.poll(() => gateway.count()).toBe(2);
    expect([...gateway.finished]).toEqual([]);
    await release(gateway, 1);
    await settleBrowser(page);
    await expect(execute(page)).toBeDisabled();
    await expect(execute(page)).toHaveText("확인 중");
    await expect(sampleInput(page)).toHaveValue(sampleB);
    await expect(selected(page)).toHaveCount(0);
    await expect(card(page).getByRole("alert")).toHaveCount(0);
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
    expect(gateway.finished.has(2)).toBe(false);
    await blockedPhysicalClick(page, execute(page));
    expect(gateway.count()).toBe(2);
    await release(gateway, 2);
    await expect(selected(page, "public-second-account")).toBeVisible();
    await expect(execute(page)).toBeEnabled();
    expect(gateway.operations.map(({ userId }) => userId)).toEqual(["preview-one", "preview-two"]);
    // Two synthetic transport attempts overlap. Browser abort may settle old
    // JS early; exact old-finally/new-flight ordering is a separate unit proof.
    await other.close();
  });
}
test("빈 모델·진행 중 키보드와 포인터 입력은 중복 전송하지 않는다", async ({ page, gateway }) => {
  await login(page);
  await blockedPhysicalClick(page, execute(page));
  expect(gateway.count()).toBe(0);
  await fields(page);
  gateway.plan(1, { hold: true });
  const button = execute(page),
    exactButton = await button.elementHandle();
  if (!exactButton) throw new Error("Missing preview execution control");
  await button.evaluate((node) => {
    node.setAttribute("data-native-start", "0");
    node.addEventListener("click", () =>
      node.setAttribute("data-native-start", String(Number(node.getAttribute("data-native-start")) + 1)),
    );
  });
  await button.click();
  await expect.poll(() => exactButton.getAttribute("data-native-start")).toBe("1");
  await expect.poll(() => gateway.count()).toBe(1);
  await sampleInput(page).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect(sampleInput(page)).toHaveValue(`${sampleA}\n`);
  await page.keyboard.press("Shift+Tab");
  await expect(keyInput(page)).toBeFocused();
  await blockedPhysicalClick(page, execute(page));
  expect(gateway.count()).toBe(1);
  await release(gateway, 1);
  await expect(selected(page)).toBeVisible();
});
test("실패는 한글 오류·요청 ID·입력을 유지하며 명시적 재시도만 전송한다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  gateway.plan(1, { status: 503 });
  await execute(page).click();
  await expect(
    card(page)
      .getByText(/미리보기를 실행하지 못했습니다/u)
      .first(),
  ).toBeVisible();
  await expect(card(page).getByText(new RegExp(requestId, "u"))).toBeVisible();
  await expect(sampleInput(page)).toHaveValue(sampleA);
  expect(gateway.count()).toBe(1);
  await execute(page).click();
  await expect(selected(page)).toBeVisible();
  expect(gateway.count()).toBe(2);
});
test("새 결과의 원문 필드·재작성 안내는 런타임 접두사를 표시하지 않는다", async ({ page, gateway }) => {
  const marker = `custom_preview_${"b".repeat(40)}`;
  gateway.setPrefixes(["custom_preview_"]);
  const response = previewResult();
  gateway.plan(1, {
    result: {
      ...response,
      requested_model: marker,
      selected_model: marker,
      selected_provider: marker,
      policy_api_key_id: marker,
      route_reason: marker,
      decision_reason: marker,
      complexity: { score: 10, tier: marker },
      risk: { score: 0, tier: marker, categories: [marker] },
      fallback_plan: [marker],
      would_rewrite: true,
    },
  });
  await login(page);
  await fields(page);
  await execute(page).click();
  await expect.poll(() => gateway.finished.has(1)).toBe(true);
  await expect(
    card(page)
      .getByText(/민감정보/u)
      .first(),
  ).toBeVisible();
  expect(await card(page).innerText()).not.toContain(marker);
  expect(await card(page).evaluate((node) => node.outerHTML)).not.toContain(marker);
  expect(gateway.operations[0]?.body).toEqual({
    model: publicModel,
    messages: [{ role: "user", content: sampleA }],
  });
});
test("샘플 원문은 새 결과에 반복하지 않고 URL·브라우저 저장소에 남기지 않는다", async ({ page, gateway }) => {
  await login(page);
  await fields(page);
  await execute(page).click();
  await expect(selected(page)).toBeVisible();
  await expect(definition(page, "샘플 기준")).toHaveText(
    "실행 당시 입력으로 계산하며 원문은 결과에 복제하지 않습니다.",
  );
  expect(await nonInputText(page)).not.toContain(sampleA);
  expect(
    await page.evaluate(
      (marker) =>
        [location.href, JSON.stringify({ ...localStorage }), JSON.stringify({ ...sessionStorage })].some(
          (value) => [marker, encodeURIComponent(marker)].some((candidate) => value.includes(candidate)),
        ),
      sampleA,
    ),
  ).toBe(false);
  await page.reload();
  await expect(card(page)).toBeVisible();
  await expect(sampleInput(page)).toHaveValue("");
  await expect(selected(page)).toHaveCount(0);
  expect(gateway.count()).toBe(1);
  // This does not prove the server, proxies or browser memory retain no data.
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
test("390px 다크 미리보기는 한글 입력·실제 키보드 실행·접근성·긴 결과 줄바꿈을 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  gateway.setMode("read_only");
  await login(page);
  const longModel = `public-${"긴원본모델".repeat(32)}`;
  gateway.plan(1, {
    hold: true,
    result: {
      ...previewResult(longModel),
      selected_provider: `public-${"긴공급자".repeat(30)}`,
      decision_reason: "공개 합성 긴 계산 사유 ".repeat(30),
    },
  });
  await fields(page, longModel, sampleA);
  await modelInput(page).click();
  await page.keyboard.press("Shift+Tab");
  await expect(execute(page)).toBeFocused();
  await page.keyboard.press("Enter");
  await expect.poll(() => gateway.count()).toBe(1);
  await expect(execute(page)).toBeDisabled();
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await release(gateway, 1);
  await expect(selected(page, longModel)).toBeVisible();
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await selected(page, longModel).scrollIntoViewIfNeeded();
  await expect(selected(page, longModel)).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: info.outputPath("routing-preview-result-explicit-scroll.png") });
  await sampleInput(page).fill(sampleB);
  const changed = card(page).getByText(/입력이 달라졌습니다/u);
  await changed.scrollIntoViewIfNeeded();
  await expect(changed).toBeInViewport({ ratio: 1 });
  await noOverflow(page);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("routing-preview-changed-explicit-scroll.png") });
  expect(gateway.count()).toBe(1);
  // Screenshots use explicit scrolling; no sticky/automatic viewport guarantee.
});
