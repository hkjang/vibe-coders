import { expect, test as base, type BrowserContext, type Locator, type Page } from "@playwright/test";

import type { UiBootstrapResponse } from "../../src/shared/api/generated";
import type { Provider } from "../../src/shared/api/schemas";

// Stateful browser/API fixtures only: no live provider, credentials, or destructive operational calls.
const publicName = "public-review-provider";
const publicRef = `prv_${"a".repeat(43)}`;
const privateRef = `prv_${"b".repeat(43)}`;
const replacementKey = "public-synthetic-review-replacement";
const originalUrl = "https://original.example.invalid/v1";
const revisedUrl = "https://revised.example.invalid/v1";
const guardTitle = "저장하지 않은 변경사항이 있습니다";
const user = {
  id: "provider-review-admin",
  email: "provider-review@example.invalid",
  name: "공급자 검토 운영자",
  role: "admin",
  roles: ["admin"],
  team_id: "public-fixture",
  scopes: ["admin:read", "admin:write", "routing:read"],
  features: { "gateway.providers": true, "gateway.health": true },
};

function bootstrap(authenticated: boolean): UiBootstrapResponse {
  return {
    backend_version: "v0.86.8",
    ui_version: "provider-review-fixture",
    api_version: "v1",
    ui: {
      enabled: true,
      default_entry: "/app/gateway/providers",
      legacy_fallback: true,
      feedback_enabled: false,
      telemetry_enabled: false,
    },
    authentication: {
      enabled: true,
      authenticated,
      mode: "session",
      keycloak_enabled: false,
      allow_local_login: true,
      sso_login_url: "/auth/keycloak/login",
      credential_prefixes: ["corp_"],
    },
    ...(authenticated ? { user } : {}),
    capabilities: { raw_prompt_view: false },
    roles: authenticated ? user.roles : [],
    permissions: authenticated ? user.scopes : [],
    allowed_features: authenticated ? ["gateway.providers", "gateway.health"] : [],
    migration_registry: [
      {
        feature_id: "gateway.providers",
        title: "AI 공급자",
        app_path: "/app/gateway/providers",
        legacy_path: "/admin#/settings",
        status: "preview",
        risk_level: "medium",
        required_permission: "admin:read",
        read_only: false,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: authenticated,
      },
      {
        feature_id: "gateway.health",
        title: "게이트웨이 상태",
        app_path: "/app/gateway/health",
        legacy_path: "/admin#/routing/health",
        status: "preview_read_only",
        risk_level: "low",
        required_permission: "routing:read",
        read_only: true,
        enabled_roles: ["admin"],
        rollout_percent: 100,
        fallback_enabled: true,
        minimum_api_version: "v0.84.0",
        available: authenticated,
      },
    ],
    system_status: { status: "healthy" },
    legacy_route_map: {
      "/app/gateway/providers": "/admin#/settings",
      "/app/gateway/health": "/admin#/routing/health",
    },
  };
}

async function installGateway(context: BrowserContext) {
  let providers: Provider[] = [
    {
      name: publicName,
      provider_ref: publicRef,
      base_url: originalUrl,
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: true,
      model_patterns: "public-model-*",
      failover_group: "public-group",
      priority: 1,
      created_at: "2026-09-29T00:00:00Z",
    },
    {
      name: "[provider-name-omitted]",
      provider_ref: privateRef,
      base_url: "https://private.example.invalid/v1",
      api_key_configured: true,
      timeout_ms: 30000,
      enabled: false,
      model_patterns: "private-model-*",
      failover_group: "public-group",
      priority: 2,
      created_at: "2026-09-29T00:00:00Z",
    },
  ];
  const sessions = new Set<string>();
  const unexpected: string[] = [];
  const saves: Record<string, unknown>[] = [];
  const deletions: string[] = [];
  const gates = new Map<string, Promise<void>>();
  const releases = new Map<string, () => void>();
  let saveStatus = 200;
  let deleteStatus = 200;
  const release = (key: string) => {
    releases.get(key)?.();
    releases.delete(key);
    gates.delete(key);
  };
  await context.route("**/*", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const call = `${request.method()} ${path}`;
    const authenticated = sessions.has(request.headers().authorization ?? "");
    const json = (body: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        headers: { "X-Request-ID": "req-provider-review-fixture" },
        body: JSON.stringify(body),
      });
    if (call === "POST /auth/login") {
      expect(request.postDataJSON()).toEqual({ email: user.email, password: "public-test-password" });
      sessions.add("Bearer public-review-access");
      return json({
        access_token: "public-review-access",
        refresh_token: "public-review-refresh",
        token_type: "Bearer",
        expires_in: 3600,
        refresh_expires_in: 7200,
        user,
      });
    }
    if (call === "GET /admin/ui-bootstrap") return json(bootstrap(authenticated));
    if (call === "GET /health") return json({ status: "ok" });
    if (call === "GET /ready") return json({ status: "ready" });
    if (path.startsWith("/admin/") || path.startsWith("/auth/")) {
      if (!authenticated) {
        unexpected.push(`unauthorized ${call}`);
        return json({ error: { message: "fixture authentication required" } }, 401);
      }
      if (call === "GET /admin/providers") return json({ providers });
      if (call === "GET /admin/providers/slo")
        return json({ slos: [], evaluations: [], since: "2026-09-29T00:00:00Z" });
      if (call === "GET /admin/routing/balancer")
        return json({
          mode: "session_hash",
          multi_instance_safe: true,
          sticky_sessions: true,
          sticky_ttl: "30m0s",
          active_sessions: 0,
          balance_index: 1,
          pools: [],
        });
      if (call === "GET /admin/routing/health")
        return json({
          since: "2026-09-28T00:00:00Z",
          until: "2026-09-29T00:00:00Z",
          threshold: 70,
          providers: [],
          ranking: [],
          degraded: [],
          alerts: [],
          trend: [],
          breakers: {
            enabled: false,
            threshold: 5,
            cooldown_seconds: 30,
            states: [],
            shared: false,
            instance_id: "fixture",
          },
        });
      if (call === "POST /admin/providers") {
        expect(request.headers()["x-vibe-ui"]).toBe("app");
        expect(request.headers()["x-vibe-route"]).toBe("gateway.providers");
        const body = request.postDataJSON() as Record<string, unknown>;
        saves.push(body);
        await gates.get("save");
        const preservesRedactedURL =
          body.base_url === "[invalid or redacted provider URL]" &&
          providers.some((provider) => provider.name === body.name && provider.base_url === body.base_url);
        const baseUrl = new URL(preservesRedactedURL ? originalUrl : String(body.base_url));
        // Mirror only the invalid userinfo/fragment case exercised here, not the
        // full Go URL policy. Such input must never become a successful fixture save.
        if (baseUrl.username || baseUrl.password || baseUrl.hash)
          return json({ error: { message: "fixture invalid URL", code: "invalid_base_url" } }, 400);
        if (saveStatus !== 200)
          return json(
            { error: { message: "fixture save failed", code: "provider_save_failed" } },
            saveStatus,
          );
        providers = providers.map((provider) =>
          provider.name === body.name
            ? {
                ...provider,
                base_url: String(body.base_url),
                enabled: body.enabled === true,
                model_patterns: String(body.model_patterns),
                failover_group: String(body.failover_group),
                timeout_ms: Number(body.timeout_ms ?? 30000),
                priority: Number(body.priority ?? 1),
              }
            : provider,
        );
        // Do not echo the synthetic replacement key, matching the public read contract.
        return json({ ok: true });
      }
      if (request.method() === "DELETE" && path.startsWith("/admin/providers/")) {
        const identifier = decodeURIComponent(path.slice("/admin/providers/".length));
        deletions.push(identifier);
        await gates.get("delete");
        if (deleteStatus !== 200)
          return json(
            { error: { message: "fixture delete failed", code: "provider_delete_failed" } },
            deleteStatus,
          );
        providers = providers.filter(
          (provider) => provider.name !== identifier && provider.provider_ref !== identifier,
        );
        return json({ ok: true });
      }
      unexpected.push(call);
      return json({ error: { message: "unexpected fixture request" } }, 501);
    }
    return route.continue();
  });
  return {
    unexpected,
    saves,
    deletions,
    setPublicURL: (url: string) => {
      providers = providers.map((provider) =>
        provider.name === publicName ? { ...provider, base_url: url } : provider,
      );
    },
    hold: (key: "save" | "delete") => {
      gates.set(key, new Promise<void>((resolve) => releases.set(key, resolve)));
    },
    release,
    setSaveStatus: (status: number) => {
      saveStatus = status;
    },
    setDeleteStatus: (status: number) => {
      deleteStatus = status;
    },
  };
}

type Gateway = Awaited<ReturnType<typeof installGateway>>;
const test = base.extend<{ gateway: Gateway }>({
  gateway: async ({ context }, run) => {
    const gateway = await installGateway(context);
    try {
      await run(gateway);
    } finally {
      gateway.release("save");
      gateway.release("delete");
      expect(gateway.unexpected).toEqual([]);
    }
  },
});

async function login(page: Page) {
  await page.goto("login?return_to=%2Fapp%2Fgateway%2Fproviders");
  await page.getByLabel("이메일", { exact: true }).fill(user.email);
  await page.getByLabel("비밀번호", { exact: true }).fill("public-test-password");
  await page.getByRole("button", { name: "로그인", exact: true }).click();
  await expect(publicRow(page)).toBeVisible();
}

const publicRow = (page: Page) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name: publicName, exact: true }) });
const privateRow = (page: Page) =>
  page.getByRole("row").filter({ has: page.getByRole("link", { name: /공급자 이름 비공개/u }) });
const editor = (page: Page) => page.getByRole("dialog", { name: "공급자 수정", exact: true });
const deletion = (page: Page) => page.getByRole("dialog", { name: "공급자 삭제", exact: true });
const guard = (page: Page) => page.getByRole("alertdialog", { name: guardTitle });

async function openEditor(page: Page): Promise<Locator> {
  await publicRow(page).getByRole("button", { name: "수정", exact: true }).click();
  await expect(editor(page)).toBeVisible();
  await expect
    .poll(() => editor(page).evaluate((element) => element.contains(document.activeElement)))
    .toBe(true);
  return editor(page);
}

async function review(dialog: Locator) {
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(dialog.getByRole("table", { name: "공급자 변경 전후 비교" })).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "변경 내용 검토", exact: true })).toBeFocused();
}

test("사용자 지정 비밀키 접두사를 로그인 설정에서 받아 비교 화면 전체에 적용한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await openEditor(page);
  const credential = `corp_${"a".repeat(32)}`;
  await dialog.getByLabel(/^기본 URL/u).fill(`https://revised.example.invalid/v1?value=${credential}`);
  await dialog.getByLabel("모델 패턴", { exact: true }).fill(credential);
  await dialog.getByLabel("장애 전환 그룹", { exact: true }).fill(credential);
  await review(dialog);
  const comparison = dialog.getByRole("table", { name: "공급자 변경 전후 비교" });
  await expect(comparison).not.toContainText(credential);
  await expect(comparison).toContainText("?value=***");
  await expect(comparison).toContainText("민감한 값은 비교에 표시하지 않습니다.");
  expect(await comparison.evaluate((element) => element.outerHTML)).not.toContain(credential);
  expect(gateway.saves).toEqual([]);
});

test("서버가 숨긴 기존 주소를 그대로 유지하면서 중지와 사용을 검토할 수 있다", async ({ page, gateway }) => {
  const hiddenURL = "[invalid or redacted provider URL]";
  gateway.setPublicURL(hiddenURL);
  await login(page);
  for (const [action, enabled] of [
    ["중지", false],
    ["사용", true],
  ] as const) {
    await publicRow(page).getByRole("button", { name: action, exact: true }).click();
    const dialog = editor(page);
    await expect(dialog.getByLabel(/^기본 URL/u)).toHaveValue(hiddenURL);
    await expect(dialog).toContainText("서버가 기존 주소를 숨겼습니다");
    await review(dialog);
    await expect(dialog.getByRole("table")).toContainText("기존 비공개 주소 유지");
    await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(gateway.saves.at(-1)).toEqual(expectedSave({ base_url: hiddenURL, enabled }));
  }
  expect(gateway.saves).toHaveLength(2);
});

function expectedSave(changes: Record<string, unknown> = {}) {
  return {
    name: publicName,
    base_url: originalUrl,
    timeout_ms: 30000,
    model_patterns: "public-model-*",
    failover_group: "public-group",
    priority: 1,
    enabled: true,
    ...changes,
  };
}

async function axeViolations(page: Page) {
  return page.evaluate(async () => {
    const axe = (
      window as unknown as {
        axe: { run: (root: Document) => Promise<{ violations: { id: string; impact: string | null }[] }> };
      }
    ).axe;
    return (await axe.run(document)).violations.map(({ id, impact }) => ({ id, impact }));
  });
}

test("공급자 비교는 비밀값을 숨기고 잘못된 URL 오류 후 다시 검토한 요청만 저장한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await openEditor(page);
  const credentialUrl =
    "https://public-user:public-password@revised.example.invalid/v1?api_key=public-url-key#private-fragment";
  await dialog.getByLabel(/^기본 URL/u).fill(` ${credentialUrl} `);
  await dialog.getByLabel("API 키", { exact: true }).fill(replacementKey);
  await dialog.getByLabel("모델 패턴", { exact: true }).fill("  revised-model-*  ");
  await dialog.getByLabel("우선순위", { exact: true }).fill("3");
  await review(dialog);
  const comparison = dialog.getByRole("table", { name: "공급자 변경 전후 비교" });
  await expect(comparison.getByRole("row", { name: /API 키/u })).toContainText("교체");
  await expect(comparison).toContainText("https://revised.example.invalid/v1?api_key=***");
  for (const hidden of [
    replacementKey,
    "public-user",
    "public-password",
    "public-url-key",
    "private-fragment",
  ])
    await expect(dialog).not.toContainText(hidden);
  await expect(dialog.getByLabel("API 키", { exact: true })).toHaveCount(0);
  expect(gateway.saves).toHaveLength(0);
  gateway.hold("save");
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).dblclick();
  await expect.poll(() => gateway.saves.length).toBe(1);
  await expect(dialog.getByRole("button", { name: "처리 중", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "다시 편집", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(guard(page)).toBeHidden();
  expect(gateway.saves).toEqual([
    expectedSave({
      base_url: credentialUrl,
      api_key: replacementKey,
      model_patterns: "revised-model-*",
      priority: 3,
    }),
  ]);
  gateway.release("save");
  await expect(dialog.getByRole("alert")).toContainText("req-provider-review-fixture");
  await expect(comparison).toBeVisible();
  expect(gateway.saves).toHaveLength(1);
  await dialog.getByRole("button", { name: "다시 편집", exact: true }).click();
  await dialog.getByLabel(/^기본 URL/u).fill(` ${revisedUrl} `);
  await review(dialog);
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(publicRow(page).getByRole("button", { name: "수정", exact: true })).toBeFocused();
  expect(gateway.saves).toHaveLength(2);
  expect(gateway.saves[1]).toEqual(
    expectedSave({
      base_url: revisedUrl,
      api_key: replacementKey,
      model_patterns: "revised-model-*",
      priority: 3,
    }),
  );
  const stored = await page.evaluate(() =>
    [...Object.values(localStorage), ...Object.values(sessionStorage)].join("\n"),
  );
  expect(stored).not.toContain(replacementKey);
  expect(stored).not.toContain(credentialUrl);
});

test("다시 편집은 이전 승인을 취소하며 빈 API 키는 기존 값 유지로 전송한다", async ({ page, gateway }) => {
  await login(page);
  const dialog = await openEditor(page);
  await dialog.getByLabel(/^기본 URL/u).fill("https://discarded.example.invalid/v1");
  await dialog.getByLabel("API 키", { exact: true }).fill(replacementKey);
  await review(dialog);
  await dialog.getByRole("button", { name: "다시 편집", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "검토한 내용 저장", exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel(/^기본 URL/u)).toBeFocused();
  await dialog.getByLabel(/^기본 URL/u).fill(revisedUrl);
  await dialog.getByLabel("API 키", { exact: true }).fill("");
  await review(dialog);
  await expect(dialog.getByRole("table").getByRole("row", { name: /API 키/u })).toContainText("유지");
  await expect(dialog.getByRole("table")).not.toContainText("discarded.example.invalid");
  expect(gateway.saves).toHaveLength(0);
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.saves).toEqual([expectedSave({ base_url: revisedUrl })]);
});

test("정수 설정의 소수 입력은 검토 전 필드 오류로 차단하고 첫 오류에 초점을 옮긴다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const dialog = await openEditor(page);
  const priority = dialog.getByLabel("우선순위", { exact: true });
  const timeout = dialog.getByLabel("제한 시간(ms)", { exact: true });
  await priority.fill("1.5");
  await timeout.fill("2.5");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(priority).toHaveAttribute("aria-invalid", "true");
  await expect(timeout).toHaveAttribute("aria-invalid", "true");
  await expect(priority).toBeFocused();
  await expect(dialog.getByRole("table", { name: "공급자 변경 전후 비교" })).toHaveCount(0);
  expect(gateway.saves).toHaveLength(0);
  await priority.fill("3");
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(timeout).toBeFocused();
  await dialog.getByRole("button", { name: "변경 내용 검토", exact: true }).click();
  await expect(timeout).toBeFocused();
  expect(gateway.saves).toHaveLength(0);
  await timeout.fill("5000");
  await review(dialog);
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.saves).toEqual([expectedSave({ priority: 3, timeout_ms: 5000 })]);
});

test("중지와 사용 바로가기도 변경 비교 승인 전에 요청을 보내지 않는다", async ({ page, gateway }) => {
  await login(page);
  for (const [action, enabled, label] of [
    ["중지", false, "비활성"],
    ["사용", true, "활성"],
  ] as const) {
    const before = gateway.saves.length;
    await publicRow(page).getByRole("button", { name: action, exact: true }).click();
    const dialog = editor(page);
    await expect(dialog.getByRole("checkbox", { name: /^활성/u })).toBeChecked({ checked: enabled });
    expect(gateway.saves).toHaveLength(before);
    await review(dialog);
    await expect(
      dialog
        .getByRole("table")
        .getByRole("row", { name: /활성 상태/u })
        .getByRole("cell")
        .last(),
    ).toHaveText(label);
    expect(gateway.saves).toHaveLength(before);
    await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      publicRow(page).getByRole("button", { name: enabled ? "중지" : "사용", exact: true }),
    ).toBeFocused();
    expect(gateway.saves.at(-1)).toEqual(expectedSave({ enabled }));
  }
  expect(gateway.saves).toHaveLength(2);
});

test("저장 실패는 승인한 비교와 요청 ID를 유지하며 명시적 재시도만 수행한다", async ({ page, gateway }) => {
  await login(page);
  gateway.setSaveStatus(503);
  const dialog = await openEditor(page);
  await dialog.getByLabel(/^기본 URL/u).fill(revisedUrl);
  await review(dialog);
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("req-provider-review-fixture");
  await expect(dialog.getByRole("table")).toContainText(revisedUrl);
  await expect(dialog.getByRole("button", { name: "검토한 내용 저장", exact: true })).toBeEnabled();
  expect(gateway.saves).toEqual([expectedSave({ base_url: revisedUrl })]);
  await page.keyboard.press("Escape");
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  expect(gateway.saves).toHaveLength(1);
  gateway.setSaveStatus(200);
  await dialog.getByRole("button", { name: "검토한 내용 저장", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(gateway.saves).toEqual([
    expectedSave({ base_url: revisedUrl }),
    expectedSave({ base_url: revisedUrl }),
  ]);
});

test("삭제는 정확한 공개 이름 확인과 중복 방지를 적용하고 실패한 확인값을 유지한다", async ({
  page,
  gateway,
}) => {
  await login(page);
  await publicRow(page).getByRole("button", { name: "삭제", exact: true }).click();
  const dialog = deletion(page);
  const input = dialog.getByLabel("삭제 대상 재입력", { exact: true });
  const button = dialog.getByRole("button", { name: "삭제", exact: true });
  await expect(button).toBeDisabled();
  for (const mismatch of [publicName.toUpperCase(), `${publicName} `, publicRef]) {
    await input.fill(mismatch);
    await expect(button).toBeDisabled();
  }
  await expect(dialog).toContainText("참조 영향은 조회하지 않았습니다");
  expect(gateway.deletions).toHaveLength(0);
  await input.fill(publicName);
  gateway.setDeleteStatus(503);
  gateway.hold("delete");
  await button.dblclick();
  await expect.poll(() => gateway.deletions.length).toBe(1);
  await expect(input).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "삭제 중", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeVisible();
  gateway.release("delete");
  await expect(dialog.getByRole("alert")).toContainText("req-provider-review-fixture");
  await expect(input).toHaveValue(publicName);
  await expect(button).toBeEnabled();
  expect(gateway.deletions).toEqual([publicName]);
  gateway.setDeleteStatus(200);
  await button.click();
  await expect(dialog).toBeHidden();
  await expect(publicRow(page)).toHaveCount(0);
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.deletions).toEqual([publicName, publicName]);
});

test("비공개 공급자는 전체 참조만 삭제 확인으로 받으며 다시 열면 확인값을 비운다", async ({
  page,
  gateway,
}) => {
  await login(page);
  const trigger = privateRow(page).getByRole("button", { name: "삭제", exact: true });
  const displayName = await privateRow(page).getByRole("link").textContent();
  await trigger.click();
  const dialog = deletion(page);
  const input = dialog.getByLabel("삭제 대상 재입력", { exact: true });
  const button = dialog.getByRole("button", { name: "삭제", exact: true });
  for (const mismatch of [
    privateRef.slice(-8),
    displayName ?? "",
    "[provider-name-omitted]",
    `${privateRef} `,
  ]) {
    await input.fill(mismatch);
    await expect(button).toBeDisabled();
  }
  await input.fill(privateRef);
  await expect(button).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(input).toHaveValue("");
  await expect(button).toBeDisabled();
  await input.fill(privateRef);
  await button.click();
  await expect(dialog).toBeHidden();
  expect(gateway.deletions).toEqual([privateRef]);
  await expect(privateRow(page)).toHaveCount(0);
});

test("실제 뒤로가기에서 승인 대기 초안을 보호하고 명시적 폐기 후 이동한다", async ({ page, gateway }) => {
  await login(page);
  const nav = page.getByRole("complementary", { name: "주 메뉴" });
  await nav.getByRole("link", { name: /게이트웨이 상태/u }).click();
  await expect(page).toHaveURL(/\/gateway\/health$/u);
  await nav.getByRole("link", { name: /AI 공급자/u }).click();
  const dialog = await openEditor(page);
  await dialog.getByLabel(/^기본 URL/u).fill(revisedUrl);
  await review(dialog);
  await page.goBack();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole("button", { name: "계속 편집" }).click();
  await expect(page).toHaveURL(/\/gateway\/providers$/u);
  await expect(dialog.getByRole("table")).toContainText(revisedUrl);
  await page.goBack();
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(page).toHaveURL(/\/gateway\/health$/u);
  await expect(dialog).toBeHidden();
  await expect(page.locator("#main-content")).toBeFocused();
  expect(gateway.saves).toHaveLength(0);
});

test("390px 다크 비교와 전체 참조 삭제 확인은 넘침과 axe 위반 없이 키보드를 지원한다", async ({
  page,
  gateway,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.addInitScript({ path: "node_modules/axe-core/axe.min.js" });
  await login(page);
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const dialog = await openEditor(page);
  await dialog
    .getByLabel(/^기본 URL/u)
    .fill(`https://revised.example.invalid/${"long-public-path-".repeat(12)}`);
  await review(dialog);
  await expect(dialog.getByText("표를 좌우로 이동해 저장할 내용을 확인하세요.")).toBeVisible();
  const scrollRegion = dialog.getByRole("region", { name: "공급자 변경 비교 표" });
  await scrollRegion.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => scrollRegion.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  await expect(dialog.getByRole("button", { name: "검토한 내용 저장", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  for (let index = 0; index < 8; index += 1) {
    await page.keyboard.press("Tab");
    await expect
      .poll(() => dialog.evaluate((element) => element.contains(document.activeElement)))
      .toBe(true);
  }
  await page.screenshot({ path: testInfo.outputPath("provider-review-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await guard(page).getByRole("button", { name: "변경 버리기" }).click();
  await expect(publicRow(page).getByRole("button", { name: "수정", exact: true })).toBeFocused();
  const trigger = privateRow(page).getByRole("button", { name: "삭제", exact: true });
  await trigger.click();
  const confirmation = deletion(page);
  await confirmation.getByLabel("삭제 대상 재입력", { exact: true }).fill(privateRef);
  await expect(confirmation.getByRole("button", { name: "삭제", exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  expect(await axeViolations(page)).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("provider-delete-mobile-dark.png") });
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(gateway.saves).toHaveLength(0);
  expect(gateway.deletions).toHaveLength(0);
});
