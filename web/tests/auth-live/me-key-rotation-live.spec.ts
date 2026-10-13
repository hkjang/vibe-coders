import { expect, type Page } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { matches, protectedChat, secretIsAbsent, type IssuedKey } from "./access-fixture";
import { admin, login, signOut, test } from "./live-fixture";

const path = "/app/me?tab=keys";
const keyItem = (page: Page, id: string) =>
  page.locator(".access-list > li").filter({
    has: page.getByText(id, { exact: true }).and(page.locator(".access-list-detail.mono")),
  });

async function issuePersonalKey(page: Page, name: string, expiry?: string): Promise<IssuedKey> {
  await page.getByRole("button", { name: "키 발급", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "키 발급", exact: true });
  await dialog.getByRole("textbox", { name: "키 이름", exact: true }).fill(name);
  if (expiry) await dialog.getByLabel("만료", { exact: true }).fill(expiry);
  await dialog.getByRole("checkbox", { name: /chat:completion/u }).check();
  const pending = page.waitForResponse((response) => matches(response, "POST", "/me/keys"));
  await dialog.getByRole("button", { name: "발급", exact: true }).click();
  const response = await pending;
  expect(response.status()).toBe(201);
  const issued: IssuedKey = await response.json();
  expect(Boolean(issued.api_key?.id) && Boolean(issued.secret)).toBe(true);
  if (expiry) {
    const expected = await page.evaluate((value) => new Date(value).toISOString(), expiry);
    const sent = response.request().postDataJSON() as { expires_at?: string };
    expect(sent.expires_at === expected).toBe(true);
    const stored = await page.request.get("/me/keys", {
      headers: { authorization: response.request().headers().authorization ?? "" },
    });
    expect(stored.status()).toBe(200);
    const catalog = (await stored.json()) as { api_keys: { id: string; expires_at?: string }[] };
    expect(
      catalog.api_keys.some(
        (key) => key.id === issued.api_key.id && Date.parse(key.expires_at ?? "") === Date.parse(expected),
      ),
    ).toBe(true);
  }
  const revealed = page.getByRole("dialog", { name: "발급된 비밀값", exact: true });
  await expect(revealed).toBeVisible();
  // Sensitive values stay in memory and never enter locators, diffs or snapshots.
  expect((await revealed.locator("code").textContent()) === issued.secret).toBe(true);
  await revealed.getByRole("button", { name: "확인했습니다", exact: true }).click();
  expect(await secretIsAbsent(page, issued.secret)).toBe(true);
  return issued;
}

async function review(page: Page, id: string, grace: string) {
  await keyItem(page, id).getByRole("button", { name: "회전", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "키 회전", exact: true });
  const confirm = dialog.getByRole("button", { name: "회전", exact: true });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel("이전 키 유예 기간", { exact: true }).selectOption(grace);
  await dialog.getByRole("textbox", { name: "확인 문구", exact: true }).fill(id);
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("textbox", { name: "변경 사유", exact: true }).fill("browser-personal-key-rotation");
  await expect(dialog.getByText(/사용 한도가 초기화되지 않으며/u)).toBeVisible();
  await expect(confirm).toBeEnabled();
  return { dialog, confirm };
}

interface RotationResult extends IssuedKey {
  rotated_from: string;
  grace_ends_at: string;
}

test("AUTH-LIVE-019 실제 개인 키 유예 회전·일회 표시·이전 키 폐기", async ({ page }) => {
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page, admin, path);
  const original = await issuePersonalKey(page, "browser-personal-grace", "2099-10-13T09:30");
  const trigger = keyItem(page, original.api_key.id).getByRole("button", { name: "회전", exact: true });
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "키 회전", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  const { dialog, confirm } = await review(page, original.api_key.id, "300");
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("Tab");
    expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  }
  // Inspect the visible, settled success notice rather than a partially
  // transparent entry frame. Do not dismiss it or exclude it from axe.
  const notice = page
    .locator('[data-sonner-toast][data-type="success"]')
    .filter({ hasText: "키를 발급했습니다." });
  await expect(notice).toBeVisible();
  await expect(notice).toHaveCSS("opacity", "1");
  const accessibility = await page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: {
          run: (root: Document) => Promise<{
            violations: {
              id: string;
              nodes: {
                target: unknown[];
                any: {
                  data?: {
                    contrastRatio?: number;
                    fgColor?: string;
                    bgColor?: string;
                    expectedContrastRatio?: string;
                  };
                }[];
              }[];
            }[];
          }>;
        };
      }
    ).axe;
    const violations = (await axe.run(document)).violations;
    const ids = violations.map(({ id }) => id);
    const contrastNodes = violations
      .filter(({ id }) => id === "color-contrast")
      .flatMap(({ nodes }) => nodes);
    const contrastGroups = contrastNodes.map(({ target }) => {
      const element = typeof target[0] === "string" ? document.querySelector(target[0]) : null;
      const categories = [
        "button",
        "select",
        "input",
        "textarea",
        "label",
        "dt",
        "dd",
        "p",
        ".inline-notice",
        "[data-sonner-toast]",
      ];
      return element ? categories.findIndex((selector) => element.closest(selector)) : -1;
    });
    const contrastMetrics = contrastNodes.map(({ target }) => {
      const element = typeof target[0] === "string" ? document.querySelector(target[0]) : null;
      const toast = element?.closest("[data-sonner-toast]");
      if (!element || !toast) return [];
      const style = getComputedStyle(element);
      const toastStyle = getComputedStyle(toast);
      const rgb = (color: string) => (color.match(/[\d.]+/gu) ?? []).slice(0, 3).map(Number);
      return [
        ...rgb(style.color),
        ...rgb(toastStyle.backgroundColor),
        Number(toastStyle.opacity),
        ["success", "info", "warning", "error"].indexOf(toast.getAttribute("data-type") ?? ""),
      ];
    });
    return {
      total: ids.length,
      contrast: ids.filter((id) => id === "color-contrast").length,
      scrollFocus: ids.filter((id) => id === "scrollable-region-focusable").length,
      hiddenFocus: ids.filter((id) => id === "aria-hidden-focus").length,
      labels: ids.filter((id) => ["label", "select-name", "button-name", "aria-dialog-name"].includes(id))
        .length,
      contrastGroups,
      contrastMetrics,
      measuredContrast: contrastNodes.map(({ any: checks }) => {
        const data = checks[0]?.data;
        const rgb = (value: string | undefined) =>
          /^#[a-f\d]{6}$/iu.test(value ?? "")
            ? [1, 3, 5].map((start) => Number.parseInt((value ?? "").slice(start, start + 2), 16))
            : [];
        return [
          data?.contrastRatio ?? 0,
          Number.parseFloat(data?.expectedContrastRatio ?? "0"),
          ...rgb(data?.fgColor),
          ...rgb(data?.bgColor),
        ];
      }),
    };
  });
  // Fixed numeric counters only: never persist axe nodes, selectors or DOM.
  await mkdir("test-results", { recursive: true });
  await writeFile("test-results/personal-key-a11y.json", JSON.stringify(accessibility));
  expect(accessibility.total).toBe(0);
  const endpoint = `/me/keys/${original.api_key.id}/rotate`;
  const pending = page.waitForResponse((response) => matches(response, "POST", endpoint));
  await confirm.click();
  const response = await pending;
  expect(response.status()).toBe(200);
  const rotated: RotationResult = await response.json();
  const sent = response.request().postDataJSON() as { expected_revision?: string; grace_seconds?: number };
  expect(/^[a-f0-9]{64}$/u.test(sent.expected_revision ?? "") && sent.grace_seconds === 300).toBe(true);
  expect(rotated.rotated_from === original.api_key.id && rotated.api_key.id !== original.api_key.id).toBe(
    true,
  );
  const serverTime = Date.parse(response.headers().date ?? "");
  const grace = Date.parse(rotated.grace_ends_at) - serverTime;
  expect(Number.isFinite(grace) && grace >= 299_000 && grace <= 301_000).toBe(true);
  const revealed = page.getByRole("dialog", { name: "회전된 비밀값", exact: true });
  await expect(revealed).toBeVisible();
  expect((await revealed.locator("code").textContent()) === rotated.secret).toBe(true);
  await revealed.getByRole("button", { name: "확인했습니다", exact: true }).click();
  expect(await secretIsAbsent(page, rotated.secret)).toBe(true);
  expect(await protectedChat(page, original.secret, "browser-access-model")).toBe(200);
  expect(await protectedChat(page, rotated.secret, "browser-access-model")).toBe(200);
  await page.reload();
  const old = keyItem(page, original.api_key.id);
  await expect(old.getByRole("button", { name: "회전", exact: true })).toBeDisabled();
  await expect(old.getByRole("button", { name: "권한 수정", exact: true })).toBeDisabled();
  await expect(old).toContainText("이전 키 유예 종료");
  await old.getByRole("button", { name: "폐기", exact: true }).click();
  const revoke = page.getByRole("dialog", { name: "키 폐기", exact: true });
  const revoked = page.waitForResponse((value) =>
    matches(value, "DELETE", `/me/keys/${original.api_key.id}`),
  );
  await revoke.getByRole("button", { name: "폐기", exact: true }).click();
  expect((await revoked).status()).toBe(200);
  expect(await protectedChat(page, original.secret, "browser-access-denied-model")).toBe(401);
  expect(await protectedChat(page, rotated.secret, "browser-access-model")).toBe(200);
  await signOut(page);
  expect(await secretIsAbsent(page, rotated.secret)).toBe(true);
});

test("AUTH-LIVE-020 실제 회전 커밋 후 응답 손실은 재전송하지 않고 목록에서 복구한다", async ({ page }) => {
  await login(page, admin, path);
  const original = await issuePersonalKey(page, "browser-personal-lost-response");
  const endpoint = `/me/keys/${original.api_key.id}/rotate`;
  let attempts = 0;
  let committed: RotationResult | undefined;
  // The real server commits. Only delivery is interrupted; no success is fabricated.
  await page.route(`**${endpoint}`, async (route) => {
    attempts++;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    committed = (await response.json()) as RotationResult;
    await route.abort("failed");
  });
  const { dialog, confirm } = await review(page, original.api_key.id, "0");
  await confirm.click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await expect(confirm).toBeDisabled();
  expect(attempts === 1 && Boolean(committed?.secret)).toBe(true);
  await dialog.getByRole("button", { name: "취소", exact: true }).click();
  await expect(
    keyItem(page, original.api_key.id).getByRole("button", { name: "회전", exact: true }),
  ).toBeDisabled();
  await page.reload();
  expect(committed !== undefined).toBe(true);
  if (!committed) throw new Error("Actual rotation result missing");
  await expect(keyItem(page, committed.api_key.id)).toBeVisible();
  await expect(
    keyItem(page, original.api_key.id).getByRole("button", { name: "회전", exact: true }),
  ).toBeDisabled();
  expect(await secretIsAbsent(page, committed.secret)).toBe(true);
  expect(await protectedChat(page, original.secret, "browser-access-denied-model")).toBe(401);
  expect(attempts).toBe(1);
  // The unusable replacement can be revoked without ever re-displaying its secret.
  await keyItem(page, committed.api_key.id).getByRole("button", { name: "폐기", exact: true }).click();
  const pending = page.waitForResponse((value) =>
    matches(value, "DELETE", `/me/keys/${committed?.api_key.id}`),
  );
  await page
    .getByRole("dialog", { name: "키 폐기", exact: true })
    .getByRole("button", { name: "폐기", exact: true })
    .click();
  expect((await pending).status()).toBe(200);
  expect(await protectedChat(page, committed.secret, "browser-access-denied-model")).toBe(401);
});
