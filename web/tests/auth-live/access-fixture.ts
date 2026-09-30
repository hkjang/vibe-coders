import { expect, type Locator, type Page, type Request, type Response } from "@playwright/test";

import { required } from "./live-fixture";

export const accessPath = "/app/access/users?tab=keys";
export const keysPath = "/admin/api-keys";
export const scopeTitle = "API 키 권한 수정";

export interface IssuedKey {
  secret: string;
  api_key: { id: string; scopes: string[] };
}

export function matches(response: Response, method: string, path: string): boolean {
  return response.request().method() === method && new URL(response.url()).pathname === path;
}

export async function prepareIssue(page: Page, name: string, scopes: string[]): Promise<Locator> {
  await page.getByRole("button", { name: "키 발급", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "API 키 발급", exact: true });
  await dialog.getByRole("textbox", { name: "이름", exact: true }).fill(name);
  await dialog.getByLabel("역할", { exact: true }).fill("developer");
  await dialog.getByLabel("팀", { exact: true }).fill(required("VIBE_AUTH_TEAM_ID"));
  for (const scope of scopes) await dialog.getByRole("checkbox", { name: new RegExp(scope) }).check();
  return dialog;
}

export async function issueKey(page: Page, name: string, scopes: string[]): Promise<IssuedKey> {
  const dialog = await prepareIssue(page, name, scopes);
  const received = page.waitForResponse((response) => matches(response, "POST", keysPath));
  await dialog.getByRole("button", { name: "발급", exact: true }).click();
  const response = await received;
  expect(response.status()).toBe(201);
  if (scopes.length === 0) {
    const body: Record<string, unknown> = response.request().postDataJSON();
    expect(Object.hasOwn(body, "scopes")).toBe(false);
  }
  const issued: IssuedKey = await response.json();
  expect(Boolean(issued.secret) && Boolean(issued.api_key?.id)).toBe(true);
  const revealed = page.getByRole("dialog", { name: "발급된 비밀값", exact: true });
  await expect(revealed).toBeVisible();
  // Never use a secret in a locator, assertion diff, message or snapshot.
  expect((await revealed.locator("code").textContent()) === issued.secret).toBe(true);
  expect(await secretIsUnstored(page, issued.secret)).toBe(true);
  return issued;
}

export async function closeSecret(page: Page): Promise<void> {
  await page
    .getByRole("dialog", { name: "발급된 비밀값", exact: true })
    .getByRole("button", { name: "확인했습니다", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "발급된 비밀값", exact: true })).toBeHidden();
}

export function keyRow(page: Page, name: string): Locator {
  return page.getByRole("row").filter({ has: page.getByText(name, { exact: true }) });
}

export async function editScopes(page: Page, name: string): Promise<Locator> {
  await keyRow(page, name).getByRole("button", { name: "권한 수정", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: scopeTitle, exact: true });
  await expect(dialog.getByRole("button", { name: "권한 저장", exact: true })).toBeEnabled();
  return dialog;
}

export async function saveScopes(page: Page, dialog: Locator, id: string, scopes: string[]): Promise<void> {
  const received = page.waitForResponse((response) => matches(response, "PATCH", `${keysPath}/${id}`));
  await dialog.getByRole("button", { name: "권한 저장", exact: true }).click();
  const response = await received;
  expect(response.status()).toBe(200);
  const body: { scopes?: string[] } = response.request().postDataJSON();
  expect(JSON.stringify(body.scopes) === JSON.stringify(scopes)).toBe(true);
  await expect(dialog).toBeHidden();
}

export async function secretIsAbsent(page: Page, secret: string): Promise<boolean> {
  return page.evaluate((value) => {
    const stored = [localStorage, sessionStorage].some((storage) =>
      Object.keys(storage).some((key) => key.includes(value) || (storage.getItem(key) ?? "").includes(value)),
    );
    const input = Array.from(document.querySelectorAll("input,textarea")).some((node) =>
      (node as HTMLInputElement | HTMLTextAreaElement).value.includes(value),
    );
    return value.length > 0 && !stored && !input && !document.documentElement.outerHTML.includes(value);
  }, secret);
}

async function secretIsUnstored(page: Page, secret: string): Promise<boolean> {
  return page.evaluate(
    (value) =>
      value.length > 0 &&
      [localStorage, sessionStorage].every((storage) =>
        Object.keys(storage).every(
          (key) => !key.includes(value) && !(storage.getItem(key) ?? "").includes(value),
        ),
      ),
    secret,
  );
}

export async function publicKeyCheck(
  page: Page,
  id: string,
  secret: string,
  scopes?: string[],
): Promise<void> {
  const result = await page.evaluate(
    async ({ id, secret, scopes }) => {
      const response = await fetch("/admin/api-keys", {
        headers: { Authorization: `Bearer ${sessionStorage.getItem("vibe.app.auth.access") ?? ""}` },
      });
      const text = await response.text();
      const data: { api_keys?: { id: string; scopes: string[] }[] } = JSON.parse(text);
      const forbidden = (value: unknown): boolean => {
        if (!value || typeof value !== "object") return false;
        return Object.entries(value).some(
          ([key, nested]) => ["secret", "key", "key_hash", "KeyHash"].includes(key) || forbidden(nested),
        );
      };
      const key = data.api_keys?.find((row) => row.id === id);
      return {
        status: response.status,
        publicOnly: !text.includes(secret) && !forbidden(data),
        found: Boolean(key),
        scopesMatch: scopes === undefined || JSON.stringify(key?.scopes) === JSON.stringify(scopes),
      };
    },
    { id, secret, scopes },
  );
  expect(result.status).toBe(200);
  expect(result.publicOnly && result.found && result.scopesMatch).toBe(true);
}

export async function protectedChat(page: Page, secret: string, model: string): Promise<number> {
  return page.evaluate(
    async ({ secret, model }) => {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: "synthetic browser access check" }],
        }),
      });
      // Consume in memory only; never put generated content into test artifacts.
      await response.arrayBuffer();
      return response.status;
    },
    { secret, model },
  );
}

// Install after the new readonly query has finished, before releasing the old
// write. Old success callbacks must not invalidate the new account's queries.
export function watchLateAccessReads(page: Page): {
  assertSettled: (response: Response) => Promise<void>;
  stop: () => void;
} {
  let reads = 0;
  const collect = (request: Request): void => {
    if (
      request.method() === "GET" &&
      ["/admin/api-keys", "/admin/users"].includes(new URL(request.url()).pathname)
    )
      reads += 1;
  };
  page.on("request", collect);
  return {
    assertSettled: async (response) => {
      expect((await response.finished()) === null).toBe(true);
      // A bounded observation window follows completed network delivery, not
      // just two animation frames. It also catches callbacks awaiting refetch.
      await page.waitForTimeout(500);
      expect(reads).toBe(0);
    },
    stop: () => page.off("request", collect),
  };
}
