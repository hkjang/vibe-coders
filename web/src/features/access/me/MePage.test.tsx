import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { MePage } from "@/features/access/me/MePage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

// `/me/*` works for any authenticated caller, so the screen must not depend on
// admin scopes.
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ role: "developer", scopes: ["chat:completion"] }) };
});

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const dashboard = {
  user_id: "usr_1",
  today: { requests: 42, tokens: 9000, cost_krw: 1200, errors: 1 },
  month: { requests: 900, tokens: 210_000, cost_krw: 45_000, errors: 12 },
  profile: {
    success_rate: 0.97,
    avg_latency_ms: 420,
    cache_rate: 0.31,
    risk_score: 12,
    summary: "안정적으로 사용 중입니다.",
    since: "2026-08-08T00:00:00Z",
    top_task_types: [{ key: "coding", requests: 300 }],
  },
  frequent_models: [{ model: "gpt-4o-mini", requests: 300, avg_cost_krw: 12, success_rate: 0.99 }],
  recent_failures: [
    {
      id: "req_1",
      model: "gpt-4o",
      status_code: 429,
      error: "rate limited",
      task_type: "coding",
      created_at: "2026-09-06T01:00:00Z",
    },
  ],
  potential_savings_krw: 3400,
  potential_savings_model: "gpt-4o-mini",
  key_alerts: [
    {
      id: "key_1",
      name: "노트북",
      user_id: "usr_1",
      team: "platform",
      expires_at: "2026-09-20T00:00:00Z",
      last_used_at: "2026-09-01T00:00:00Z",
      days_idle: 6,
      flags: ["expiring_soon"],
      severity: "warn",
    },
  ],
  recent_blocks: [],
  my_saved_reports: [],
};

const actions = {
  user_id: "usr_1",
  count: 1,
  actions: [
    {
      type: "cost_spike",
      severity: "warn",
      message: "이번 주 비용이 급증했습니다.",
      button_label: "비용 보기",
      button_href: "#/billing",
    },
  ],
};

function handlers(overrides: Record<string, () => unknown> = {}) {
  return {
    "GET /me/dashboard": () => dashboard,
    "GET /me/actions": () => actions,
    "GET /me/notifications": () => ({ user_id: "usr_1", count: 0, critical_count: 0, notifications: [] }),
    "GET /me/report": () => ({ user_id: "usr_1", window: "weekly", requests: 900, cost_krw: 45_000 }),
    ...overrides,
  };
}

describe("MePage", () => {
  it("renders the personal dashboard without admin scopes", async () => {
    mockApi(handlers());
    renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    expect(await screen.findByText("이번 주 비용이 급증했습니다.")).toBeVisible();
    expect(screen.getAllByText("gpt-4o-mini").length).toBeGreaterThan(0);
    // The server has no `key_alerts[].reason`; flags carry the signal instead.
    expect(screen.getByText(/expiring_soon/u)).toBeVisible();
  });

  it("shows empty states when there is nothing to act on", async () => {
    mockApi(
      handlers({
        "GET /me/dashboard": () => ({ user_id: "usr_1" }),
        "GET /me/actions": () => ({ user_id: "usr_1", count: 0, actions: [] }),
      }),
    );
    renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    expect(await screen.findByText("처리할 액션이 없습니다.")).toBeVisible();
    expect(screen.getByText("새 알림이 없습니다.")).toBeVisible();
  });

  it("surfaces the request id when the dashboard fails", async () => {
    mockApi(
      handlers({
        "GET /me/dashboard": () => {
          throw apiFailure("boom", 500, "req_me_1");
        },
      }),
    );
    renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((node) => node.textContent?.includes("req_me_1"))).toBe(true);
  });

  it("snoozes an action after confirmation", async () => {
    const user = userEvent.setup();
    const api = mockApi(
      handlers({
        "POST /me/actions/snooze": () => ({ type: "cost_spike", snoozed_until: "2026-09-14T00:00:00Z" }),
      }),
    );
    renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    await user.click(await screen.findByRole("button", { name: "7일 숨기기" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: "숨기기" }));

    await waitFor(() => {
      expect(api.bodies("POST /me/actions/snooze")).toEqual([{ type: "cost_spike", days: 7 }]);
    });
  });

  it("restores the keys tab from the URL and explains a disabled self-service flag", async () => {
    mockApi({
      ...handlers(),
      "GET /me/keys": () => {
        throw apiFailure("self-service key management is disabled", 404, "req_me_keys");
      },
      "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
    });
    renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=keys" });

    expect(await screen.findByText("셀프 서비스 키 발급이 꺼져 있습니다.")).toBeVisible();
    expect(screen.getByRole("tab", { name: "내 키·연결" })).toHaveAttribute("aria-selected", "true");
  });

  it("issues a self-service key and shows the plaintext once", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /me/keys": () => ({ api_keys: [], role: "developer", grantable_scopes: ["chat:completion"] }),
      "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
      "POST /me/keys": () => ({
        api_key: { id: "key_new", name: "노트북", scopes: ["chat:completion"], status: "active" },
        secret: "vc_sk_plaintext_once",
      }),
    });
    renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=keys" });

    await user.click(await screen.findByRole("button", { name: "키 발급" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/키 이름/u), "노트북");
    await user.click(within(dialog).getByRole("button", { name: "발급" }));

    await waitFor(() => {
      expect(api.bodies("POST /me/keys")).toEqual([{ name: "노트북" }]);
    });
    expect(await screen.findByText("vc_sk_plaintext_once")).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    mockApi(handlers());
    const { container } = renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    await screen.findByText("이번 주 비용이 급증했습니다.");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
