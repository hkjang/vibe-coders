import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AppPage } from "@/features/agents/apps/AppPage";
import { AppError } from "@/shared/api/error";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const app = {
  id: "app_review",
  title: "코드 리뷰 어시스턴트",
  description: "PR을 표준 기준으로 리뷰합니다.",
  icon: "🔍",
  components: [
    { kind: "skill", ref: "code-review", label: "코드 리뷰 Skill" },
    { kind: "model", ref: "gpt-4o", label: "추천 모델" },
  ],
  allowed_teams: "platform",
  allowed_roles: "",
  status: "active",
  owner: "operator@example.com",
  created_at: "2026-09-01T00:00:00Z",
  updated_at: "2026-09-05T02:00:00Z",
};

const listHandler = () => ({ apps: [app] });

function renderPage(route = "/agents/apps"): ReturnType<typeof renderScreen> {
  return renderScreen(<AppPage />, { path: "/agents/apps", route });
}

describe("AppPage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the app list with its key values", async () => {
    mockApi({ "GET /admin/apps": listHandler });
    renderPage();

    const table = await screen.findByRole("table", { name: "AI 업무 앱 목록" });
    expect(within(table).getByText(/코드 리뷰 어시스턴트/u)).toBeVisible();
    expect(within(table).getByText("활성")).toBeVisible();
    expect(within(table).getByText("platform · 전체 역할")).toBeVisible();
  });

  it("shows an empty state when no app exists", async () => {
    mockApi({ "GET /admin/apps": () => ({ apps: [] }) });
    renderPage();

    expect(await screen.findByText("아직 업무 앱이 없습니다.")).toBeVisible();
  });

  it("shows the request id when the list fails", async () => {
    mockApi({
      "GET /admin/apps": () => {
        throw apiFailure("app store unavailable", 500, "req_app_1");
      },
    });
    renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent("요청 ID: req_app_1");
  });

  it("disables write actions without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({ "GET /admin/apps": listHandler });
    renderPage();

    expect(await screen.findByRole("button", { name: /새 업무 앱/u })).toBeDisabled();
  });

  it("validates an app from the detail panel", async () => {
    const user = userEvent.setup();
    mockApi({
      "GET /admin/apps": listHandler,
      "POST /admin/apps/app_review/validate": () => ({
        ok: false,
        checks: [
          {
            kind: "skill",
            ref: "code-review",
            label: "코드 리뷰 Skill",
            resolved: true,
            detail: "스킬 상태=production",
          },
          { kind: "model", ref: "gpt-4o", label: "추천 모델", resolved: true, detail: "추천 모델" },
        ],
        allowed_models: ["gpt-4o"],
        warnings: ["팀/역할 제한이 없어 모든 사용자에게 노출됩니다"],
      }),
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "코드 리뷰 어시스턴트 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "검증" }));

    expect(await screen.findByText("확인되지 않은 구성 요소가 있습니다.")).toBeVisible();
    expect(screen.getByText("허용 모델: gpt-4o")).toBeVisible();
  });

  it("publishes an app and offers a forced publish when the onboarding gate blocks it", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/apps": listHandler,
      "POST /admin/apps/app_review/publish": (options) => {
        if ((options.query as { force?: string } | undefined)?.force === "1") {
          return { id: "app_review", version: 2, status: "active", published: true };
        }
        throw new AppError("발행 전 온보딩 필수 항목이 충족되지 않았습니다.", {
          kind: "http",
          status: 422,
          requestId: "req_app_gate",
          details: {
            error: { message: "발행 전 온보딩 필수 항목이 충족되지 않았습니다." },
            checks: [
              { key: "title", ok: true, severity: "required", detail: "앱 제목이 필요합니다." },
              { key: "owner", ok: false, severity: "required", detail: "책임자(owner)를 지정해야 합니다." },
            ],
          },
        });
      },
    });
    renderPage();

    await user.click(await screen.findByRole("button", { name: "코드 리뷰 어시스턴트 상세 열기" }));
    await user.click(await screen.findByRole("button", { name: "발행" }));
    await user.type(await screen.findByLabelText(/변경 사유/u), "9월 릴리스");
    await user.click(screen.getByRole("button", { name: "발행" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/apps/app_review/publish")).toEqual([{ note: "9월 릴리스" }]);
    });

    const forceDialog = await screen.findByRole("dialog", {
      name: "온보딩 미충족 상태로 강제 발행",
    });
    expect(within(forceDialog).getByText(/책임자\(owner\)를 지정해야 합니다\./u)).toBeVisible();
    await user.type(within(forceDialog).getByLabelText(/변경 사유/u), "예외 승인됨");
    await user.click(within(forceDialog).getByRole("button", { name: "강제 발행" }));

    await waitFor(() => {
      expect(api.calls.filter((call) => call.key === "POST /admin/apps/app_review/publish")).toHaveLength(2);
    });
  });

  it("creates an app from a template", async () => {
    const user = userEvent.setup();
    const api = mockApi({
      "GET /admin/apps": listHandler,
      "GET /admin/app-templates": () => ({
        templates: [
          {
            key: "code-review",
            title: "코드 리뷰 어시스턴트",
            description: "PR/디프를 표준 기준으로 리뷰합니다.",
            icon: "🔍",
            category: "개발",
            components: [{ kind: "skill", ref: "code-review", label: "코드 리뷰 Skill" }],
          },
        ],
        note: "내장 업무 앱 시작 템플릿입니다.",
      }),
      "POST /admin/app-templates/instantiate": () => ({
        app_id: "app_new",
        template: "code-review",
        note: "생성됨",
      }),
    });
    renderPage("/agents/apps?tab=templates");

    await user.click(await screen.findByRole("button", { name: "앱 생성" }));
    await user.click(await screen.findByRole("button", { name: "앱 생성" }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/app-templates/instantiate")).toEqual([{ key: "code-review" }]);
    });
  });

  it("restores the runs tab from the URL", async () => {
    mockApi({
      "GET /admin/apps": listHandler,
      "GET /v1/app-runs/apprun_1/receipt": () => ({
        run_id: "apprun_1",
        kind: "app",
        app_id: "app_review",
        app_title: "코드 리뷰 어시스턴트",
        status: "planned",
        error_class: "",
        output_summary: "2 components planned",
        input_hash: "sha256:abc",
        latency_ms: 12,
        cost_krw: 0,
        created_at: "2026-09-06T01:00:00Z",
        note: "AI 업무 앱 실행 영수증입니다.",
      }),
      "GET /me/app-runs": () => ({
        runs: [
          {
            id: "apprun_1",
            app_id: "app_review",
            user_id: "usr_test",
            team: "platform",
            status: "planned",
            input_hash: "sha256:abc",
            output_summary: "2 components planned",
            error_class: "",
            latency_ms: 12,
            cost_krw: 0,
            trace_id: "",
            created_at: "2026-09-06T01:00:00Z",
          },
        ],
      }),
    });
    renderPage("/agents/apps?tab=runs");

    const table = await screen.findByRole("table", { name: "내 업무 앱 실행 이력" });
    expect(within(table).getByText("코드 리뷰 어시스턴트")).toBeVisible();
    expect(within(table).getByText("2 components planned")).toBeVisible();

    await userEvent.setup().click(screen.getByRole("button", { name: "실행 apprun_1 영수증 열기" }));
    const dialog = await screen.findByRole("dialog", { name: "업무 앱 실행 영수증" });
    expect(within(dialog).getByText("sha256:abc")).toBeVisible();
  });

  it("has no automated accessibility violations", async () => {
    mockApi({ "GET /admin/apps": listHandler });
    const { container } = renderPage();

    await screen.findByRole("table", { name: "AI 업무 앱 목록" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
