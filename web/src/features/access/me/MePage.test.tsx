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

const myKeys = {
  api_keys: [
    {
      id: "key_mine",
      name: "노트북",
      owner: "",
      team: "platform",
      user_id: "usr_1",
      role: "developer",
      status: "active",
      scopes: ["chat:completion"],
      allowed_ips: [],
      expires_at: "",
      created_at: "2026-08-01T00:00:00Z",
    },
  ],
  role: "developer",
  grantable_scopes: ["chat:completion", "models:read"],
};

const skills = {
  team: "platform",
  available: [
    {
      name: "code-review",
      description: "코드 리뷰 보조",
      risk_level: "low",
      runs_30d: 120,
      success_rate: 0.98,
      users_30d: 12,
      satisfaction: 4.3,
      feedback_count: 9,
    },
  ],
  requestable: [
    {
      name: "prod-deploy",
      description: "배포 자동화",
      risk_level: "high",
      runs_30d: 0,
      success_rate: -1,
      users_30d: 0,
      satisfaction: -1,
      feedback_count: 0,
    },
  ],
};

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

  it("edits a key's scopes, sending an empty array to inherit the role", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /me/keys": () => myKeys,
      "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
      "PATCH /me/keys/key_mine": () => ({ id: "key_mine", scopes: [] }),
    });
    renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=keys" });

    await user.click(await screen.findByRole("button", { name: "스코프 수정" }));
    const dialog = await screen.findByRole("dialog");
    await user.click(within(dialog).getByLabelText("chat:completion"));
    await user.click(within(dialog).getByRole("button", { name: "저장" }));

    await waitFor(() => {
      expect(api.bodies("PATCH /me/keys/key_mine")).toEqual([{ scopes: [] }]);
    });
  });

  it("rotates a key after confirmation and shows the new secret once", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /me/keys": () => myKeys,
      "GET /me/sessions": () => ({ current_session_id: "", sessions: [] }),
      "POST /me/keys/key_mine/rotate": () => ({
        rotated_from: "key_mine",
        api_key: { id: "key_new", name: "노트북", scopes: ["chat:completion"], status: "active" },
        secret: "vc_sk_rotated_once",
      }),
    });
    renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=keys" });

    await user.click(await screen.findByRole("button", { name: "회전" }));
    const confirm = await screen.findByRole("dialog");
    await user.click(within(confirm).getByRole("button", { name: "회전" }));

    await waitFor(() => {
      expect(api.calls.filter((call) => call.key === "POST /me/keys/key_mine/rotate")).toHaveLength(1);
    });
    expect(await screen.findByText("vc_sk_rotated_once")).toBeVisible();
  });

  it("requests access to a skill with a reason", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /me/skills": () => skills,
      "POST /me/skills/prod-deploy/request-access": () => ({ status: "requested", skill: "prod-deploy" }),
    });
    renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=skills" });

    await user.click(await screen.findByRole("button", { name: "접근 신청" }));
    const dialog = await screen.findByRole("dialog");
    await user.type(within(dialog).getByLabelText(/신청 사유/u), "배포 담당");
    await user.click(within(dialog).getByRole("button", { name: "신청" }));

    await waitFor(() => {
      expect(api.bodies("POST /me/skills/prod-deploy/request-access")).toEqual([{ reason: "배포 담당" }]);
    });
  });

  it("sends skill feedback in the 1..5 range", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      ...handlers(),
      "GET /me/skills": () => skills,
      "POST /me/skills/code-review/feedback": () => ({ status: "recorded", skill: "code-review" }),
    });
    const { container } = renderScreen(<MePage />, { path: "/me/*", route: "/me?tab=skills" });

    await screen.findByText("code-review");
    expect((await axe.run(container)).violations).toEqual([]);
    await user.click(screen.getByRole("button", { name: "평가하기" }));
    const dialog = await screen.findByRole("dialog");
    await user.selectOptions(within(dialog).getByLabelText(/점수/u), "4");
    await user.type(within(dialog).getByLabelText("의견"), "도움이 됩니다");
    await user.click(within(dialog).getByRole("button", { name: "평가 보내기" }));

    await waitFor(() => {
      expect(api.bodies("POST /me/skills/code-review/feedback")).toEqual([
        { rating: 4, comment: "도움이 됩니다" },
      ]);
    });
  });

  it("has no automated accessibility violations", async () => {
    mockApi(handlers());
    const { container } = renderScreen(<MePage />, { path: "/me/*", route: "/me" });

    await screen.findByText("이번 주 비용이 급증했습니다.");
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
