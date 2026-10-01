import { expect, type Locator, type Page } from "@playwright/test";
import {
  test,
  account,
  draftKey,
  draftURL,
  originalURL,
  providerName,
  providerRef,
  success,
} from "./fixtures/provider-connection";

// Synthetic transport only: real React/auth/FeatureRoute behavior, no actual Go,
// provider calls, secrets, server cancellation or final-save CAS proof.
const successLabel = "모델 목록 연결을 확인했습니다.";
const result = (dialog: Locator) =>
  dialog.getByRole("region", { name: "저장 전 연결 테스트 결과", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: "저장하지 않은 변경사항이 있습니다" });
async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgateway%2Fproviders");
  await page.getByLabel("이메일", { exact: true }).fill(account.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(page.getByRole("link", { name: providerName, exact: true })).toBeVisible();
  await page.getByLabel("자동 새로고침 간격").selectOption("0");
}
async function create(page: Page, key = draftKey) {
  await page.getByRole("button", { name: "공급자 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "공급자 추가", exact: true });
  await dialog.getByLabel(/^이름/u).fill("new-public-provider");
  await dialog.getByLabel(/^기본 URL/u).fill(draftURL);
  if (key) await dialog.getByLabel("API 키", { exact: true }).fill(key);
  return dialog;
}
async function edit(page: Page) {
  await page
    .getByRole("row")
    .filter({ has: page.getByRole("link", { name: providerName, exact: true }) })
    .getByRole("button", { name: "수정", exact: true })
    .click();
  return page.getByRole("dialog", { name: "공급자 수정", exact: true });
}
async function run(dialog: Locator) {
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(result(dialog).getByText(successLabel, { exact: true })).toBeVisible();
}
async function runtime(page: Page) {
  const response = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/admin/ui-bootstrap",
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  expect((await response).ok()).toBe(true);
  await (await response).finished();
}
async function physicalClick(page: Page, control: Locator) {
  await control.scrollIntoViewIfNeeded();
  const box = await control.boundingBox();
  if (!box) throw new Error("Missing physical click target");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

test("새 초안 검사는 저장·비밀 복제 없이 dirty를 유지하며 실제 저장과 분리된다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await create(page);
  await run(dialog);
  expect(gateway.probes).toEqual([
    { name: "new-public-provider", base_url: draftURL, credential_mode: "draft", api_key: draftKey },
  ]);
  expect(gateway.saves).toEqual([]);
  await expect(dialog.getByLabel("API 키", { exact: true })).toHaveValue(draftKey);
  expect(await result(dialog).evaluate((node) => node.outerHTML)).not.toContain(draftKey);
  expect(
    await page.evaluate(
      () => `${location.href} ${JSON.stringify(localStorage)} ${JSON.stringify(sessionStorage)}`,
    ),
  ).not.toContain(draftKey);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집", exact: true }).click();
  await expect(guard(page)).toBeHidden();
  await expect(dialog.getByLabel("API 키", { exact: true })).toHaveValue(draftKey);
  await dialog.getByRole("button", { name: "저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.saves).toHaveLength(1);
  expect(gateway.probes).toHaveLength(1);
});

test("기존 빈 키 검사는 opaque 참조와 stored만 보내며 수정·검토·저장하지 않는다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await edit(page);
  await dialog.getByLabel("제한 시간(ms)", { exact: true }).fill("7500");
  await run(dialog);
  expect(gateway.probes).toEqual([
    { provider_ref: providerRef, base_url: originalURL, timeout_ms: 7500, credential_mode: "stored" },
  ]);
  expect(gateway.saves).toEqual([]);
  expect(gateway.provider()?.timeout_ms).toBe(30000);
  await expect(dialog.getByLabel("API 키", { exact: true })).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "변경 내용 검토", exact: true })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "변경 내용 검토", exact: true })).toHaveCount(0);
});

test("주소가 달라진 빈 키는 전송하지 않고 새 키 입력 후 draft 모드만 보낸다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await edit(page);
  await dialog.getByLabel(/^기본 URL/u).fill(draftURL);
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(
    dialog.getByText("주소를 변경한 경우 새 API 키를 입력해야 연결을 확인할 수 있습니다.", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByLabel("API 키", { exact: true })).toBeFocused();
  expect(gateway.probes).toEqual([]);
  await dialog.getByLabel("API 키", { exact: true }).fill(draftKey);
  await run(dialog);
  expect(gateway.probes).toEqual([
    {
      provider_ref: providerRef,
      base_url: draftURL,
      timeout_ms: 30000,
      credential_mode: "draft",
      api_key: draftKey,
    },
  ]);
  expect(gateway.saves).toEqual([]);
});

test("키 없는 새 초안은 명시적 동의 후 none이며 키 필드를 보내지 않는다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await create(page, "");
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(dialog.getByLabel("API 키", { exact: true })).toBeFocused();
  expect(gateway.probes).toEqual([]);
  await dialog.getByRole("checkbox", { name: /^API 키 없이 확인/u }).check();
  await run(dialog);
  expect(gateway.probes).toEqual([
    { name: "new-public-provider", base_url: draftURL, credential_mode: "none" },
  ]);
  expect(gateway.saves).toEqual([]);
});

for (const [outcome, upstream_status, label] of [
  ["authentication_rejected", 401, "공급자가 인증을 거부했습니다."],
  ["redirect_blocked", 302, "다른 주소로의 이동을 차단했습니다."],
  ["invalid_response", 200, "모델 목록 응답 형식을 확인할 수 없습니다."],
  ["timeout", null, "연결 확인 시간이 초과되었습니다."],
] as const) {
  test(`HTTP200 ${outcome}는 성공·인증 갱신·자동 재시도가 아니다`, async ({ page, gateway }) => {
    gateway.reply(1, { body: { ...success, outcome, upstream_status, model_count: null } });
    await login(page);
    const dialog = await edit(page);
    await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
    await expect(result(dialog).getByText(label, { exact: true })).toBeVisible();
    await expect(result(dialog).getByText(successLabel, { exact: true })).toHaveCount(0);
    expect(gateway.probes).toHaveLength(1);
    expect(gateway.refreshes()).toBe(0);
    expect(gateway.saves).toEqual([]);
  });
}

test("같은 입력 재검사 실패는 옛 성공을 제거하고 수동 재시도만 새 결과를 낸다", async ({ page, gateway }) => {
  gateway.reply(2, {
    status: 503,
    body: { error: { message: "public synthetic failure", code: "provider_connection_unavailable" } },
  });
  await login(page);
  const dialog = await edit(page);
  await run(dialog);
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(dialog.getByText("연결 테스트를 실행하지 못했습니다.", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("요청 ID: req-public-provider-connection", { exact: false })).toBeVisible();
  await expect(result(dialog)).toHaveCount(0);
  expect(gateway.probes).toHaveLength(2);
  await run(dialog);
  expect(gateway.probes).toHaveLength(3);
  expect(gateway.probes[2]).toEqual(gateway.probes[0]);
  expect(gateway.saves).toEqual([]);
});

test("대기 중 실제 반복 클릭은 한 요청이고 저장·닫기를 막으며 검사 초점은 유지한다", async ({
  page,
  gateway,
}) => {
  gateway.hold(1);
  await login(page);
  const dialog = await create(page);
  const probe = dialog.getByRole("button", { name: "연결 테스트", exact: true });
  const node = await probe.elementHandle();
  if (!node) throw new Error("Missing probe button");
  await node.evaluate((element) => {
    element.dataset.nativeClicks = "0";
    element.addEventListener("click", () => {
      element.dataset.nativeClicks = String(Number(element.dataset.nativeClicks) + 1);
    });
  });
  await probe.click();
  await expect.poll(() => gateway.probes.length).toBe(1);
  const pending = dialog.getByRole("button", { name: "연결 확인 중", exact: true });
  await expect(pending).toBeDisabled();
  await expect(pending).toBeFocused();
  await physicalClick(page, pending);
  expect(await node.getAttribute("data-native-clicks")).toBe("2");
  expect(gateway.probes).toHaveLength(1);
  const save = dialog.getByRole("button", { name: "처리 중", exact: true });
  await expect(save).toBeDisabled();
  await physicalClick(page, save);
  expect(gateway.saves).toEqual([]);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  gateway.release(1);
  await expect(result(dialog).getByText(successLabel, { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
});

for (const mode of ["flag", "status"] as const) {
  test(`열린 초안 ${mode} 읽기 전용 전환은 늦은 결과·새 요청을 막고 수동 복구한다`, async ({
    page,
    gateway,
  }) => {
    gateway.hold(1);
    await login(page);
    const dialog = await edit(page);
    await dialog.getByLabel("제한 시간(ms)", { exact: true }).fill("7500");
    await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
    await expect.poll(() => gateway.probes.length).toBe(1);
    gateway.readonly(mode);
    await runtime(page);
    await expect(
      dialog.getByText("이 화면은 읽기 전용입니다. 변경 저장과 실제 외부 실행을 할 수 없습니다.", {
        exact: true,
      }),
    ).toBeVisible();
    gateway.release(1);
    const probe = dialog.getByRole("button", { name: "연결 테스트", exact: true });
    await expect(probe).toBeDisabled();
    await expect(result(dialog)).toHaveCount(0);
    await expect(dialog.getByLabel("제한 시간(ms)", { exact: true })).toHaveValue("7500");
    await physicalClick(page, probe);
    expect(gateway.probes).toHaveLength(1);
    gateway.readonly(false);
    await runtime(page);
    await expect(probe).toBeEnabled();
    expect(gateway.probes).toHaveLength(1);
    await run(dialog);
    expect(gateway.probes).toHaveLength(2);
    expect(gateway.saves).toEqual([]);
  });
}

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
async function bounds(page: Page, dialog: Locator) {
  expect(
    await page.evaluate(
      () =>
        document.documentElement.scrollWidth <= window.innerWidth &&
        document.body.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  for (const control of await dialog.locator(".dialog-footer button").all()) {
    await expect(control).toBeInViewport({ ratio: 1 });
    expect(
      await control.evaluate((node) => {
        const rect = node.getBoundingClientRect();
        const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return target === node || (target !== null && node.contains(target));
      }),
    ).toBe(true);
  }
}
test("390px 다크 연결 검사는 첫 오류 초점·대기 키보드 스크롤·전체 버튼·axe를 유지한다", async ({
  page,
  gateway,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  // The responsive shell hides this login helper's refresh selector at 390px.
  // Configure it through the visible desktop control before mobile assertions.
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("button", { name: "공급자 추가", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "공급자 추가", exact: true });
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect(dialog.getByText("공급자 이름을 입력하세요.", { exact: true })).toBeVisible();
  await expect(dialog.getByLabel(/^이름/u)).toBeFocused();
  expect(gateway.probes).toEqual([]);
  await dialog.getByLabel(/^이름/u).fill("공개연결검사공급자");
  await dialog.getByLabel(/^기본 URL/u).fill(`${draftURL}/${"public-path-".repeat(16)}`);
  await dialog.getByLabel("API 키", { exact: true }).fill(draftKey);
  await bounds(page, dialog);
  expect(await axe(page)).toEqual([]);
  gateway.hold(1);
  await dialog.getByRole("button", { name: "연결 테스트", exact: true }).click();
  await expect.poll(() => gateway.probes.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "연결 확인 중", exact: true })).toBeFocused();
  const hint = dialog.getByText(
    "입력과 연결 결과는 이 영역에서 위아래 방향키로 스크롤해 확인할 수 있습니다.",
    { exact: true },
  );
  let reached = false;
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    await expect.poll(() => dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
    if (await hint.evaluate((node) => node === document.activeElement)) {
      reached = true;
      break;
    }
  }
  expect(reached).toBe(true);
  const body = dialog.locator(".dialog-body");
  const before = await body.evaluate((node) => node.scrollTop);
  expect(before).toBeGreaterThan(0);
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => body.evaluate((node) => node.scrollTop)).toBeLessThan(before);
  await bounds(page, dialog);
  expect(await axe(page)).toEqual([]);
  gateway.release(1);
  await expect(result(dialog).getByText(successLabel, { exact: true })).toBeVisible();
  await result(dialog).scrollIntoViewIfNeeded();
  await bounds(page, dialog);
  expect(await axe(page)).toEqual([]);
  await page.screenshot({ path: info.outputPath("provider-connection-mobile-dark.png") });
  expect(gateway.probes).toHaveLength(1);
  expect(gateway.saves).toEqual([]);
});
