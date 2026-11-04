import { expect, test } from "@playwright/test";
import type { UiBootstrapResponse } from "../../src/shared/api/generated";

// Public synthetic keys only; this verifies pre-history browser boundaries, not backend auth.
for (const [id, label] of [
  ["apps", "업무 앱 검색"],
  ["workflows", "워크플로 검색"],
  ["skills", "스킬 검색"],
] as const)
  for (const [prefix, encoded] of [
    ["corp_", false],
    ["%41_", true],
    ["조직_", true],
  ] as const) {
    test(`${id} ${prefix}: 비밀 검색을 기록 전에 차단하고 정상 검색으로 복구한다`, async ({ page }) => {
      const key = `${prefix}${"x".repeat(32)}`;
      const candidate = encoded ? encodeURIComponent(encodeURIComponent(key)) : key;
      const variants = [
        key,
        candidate,
        encodeURIComponent(candidate),
        encodeURIComponent(encodeURIComponent(candidate)),
      ];
      const path = `/app/agents/${id}`;
      const feature = `agents.${id}`;
      const bootstrap: UiBootstrapResponse = {
        backend_version: "v0.86.61",
        ui_version: "synthetic-agent-search",
        api_version: "v1",
        ui: {
          enabled: true,
          default_entry: path,
          legacy_fallback: true,
          feedback_enabled: false,
          telemetry_enabled: false,
        },
        authentication: {
          enabled: false,
          authenticated: true,
          mode: "open",
          keycloak_enabled: false,
          allow_local_login: true,
          sso_login_url: "/auth/keycloak/login",
          credential_prefixes: [prefix],
        },
        user: {
          id: "synthetic-reader",
          email: "reader@example.invalid",
          name: "합성 조회자",
          role: "admin",
          roles: ["admin"],
          team_id: "synthetic-team",
          scopes: ["admin:read"],
          features: { [feature]: true },
        },
        roles: ["admin"],
        permissions: ["admin:read"],
        allowed_features: [feature],
        capabilities: { raw_prompt_view: false },
        migration_registry: [
          {
            feature_id: feature,
            title: label,
            app_path: path,
            legacy_path: "/admin",
            status: "preview",
            risk_level: "medium",
            required_permission: "admin:read",
            read_only: true,
            enabled_roles: [],
            rollout_percent: 100,
            fallback_enabled: true,
            minimum_api_version: "v0.84.0",
            available: true,
          },
        ],
        system_status: { status: "healthy" },
        legacy_route_map: { [path]: "/admin" },
      };
      const unexpected: string[] = [];
      let leakedRequest = false;
      page.on("request", (request) => {
        if (variants.some((value) => request.url().includes(value))) leakedRequest = true;
      });
      await page.route("**/*", (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const call = `${request.method()} ${url.pathname}`;
        const json = (body: unknown) => route.fulfill({ json: body });
        if (call === "GET /admin/ui-bootstrap") return json(bootstrap);
        if (call === "GET /health" || call === "GET /ready") return json({ status: "ok" });
        if (call === "GET /admin/apps") return json({ apps: [] });
        if (call === "GET /admin/workflows") return json({ workflows: [] });
        if (call === "GET /admin/skills") return json({ skills: [] });
        if (call === "GET /admin/skills/stats") return json({ stats: [] });
        if (/^\/(admin|auth|me|v1)(\/|$)/u.test(url.pathname)) {
          unexpected.push(call);
          return route.fulfill({
            status: 501,
            json: { error: { message: "Unexpected synthetic endpoint" } },
          });
        }
        return route.continue();
      });
      await page.addInitScript((values) => {
        const state = window as unknown as { agentSearchLeaked: boolean };
        state.agentSearchLeaked = false;
        for (const method of ["pushState", "replaceState"] as const) {
          const original = history[method];
          history[method] = function (data, unused, url) {
            if (url && values.some((value) => String(url).includes(value))) state.agentSearchLeaked = true;
            return original.call(this, data, unused, url);
          };
        }
      }, variants);
      await page.goto(`agents/${id}?status=active`);
      const input = page.getByRole("textbox", { name: label, exact: true });
      await expect(input).toBeVisible();
      const original = page.url();
      await input.fill(candidate);
      await input.press("Enter");
      await expect(input).toHaveAttribute("aria-invalid", "true");
      await expect(input).toBeFocused();
      await expect(page.getByRole("alert").filter({ hasText: "주소에 저장하지 않습니다" })).toBeVisible();
      await expect(page).toHaveURL(original);
      expect(
        await page.evaluate(() => (window as unknown as { agentSearchLeaked: boolean }).agentSearchLeaked),
      ).toBe(false);
      await input.fill("분기 보고");
      await input.press("Enter");
      await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("분기 보고");
      await expect(input).not.toHaveAttribute("aria-invalid", "true");
      expect(new URL(page.url()).searchParams.get("status")).toBe("active");
      expect(
        await page.evaluate(
          (values) =>
            [localStorage, sessionStorage].every((storage) =>
              Object.values(storage).every(
                (value) => !values.some((fragment) => String(value).includes(fragment)),
              ),
            ),
          variants,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { agentSearchLeaked: boolean }).agentSearchLeaked),
      ).toBe(false);
      expect(leakedRequest).toBe(false);
      expect(unexpected).toEqual([]);
    });
  }
