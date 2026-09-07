import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProbePage } from "@/features/observability/probes/ProbePage";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const authRuntime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"] }));

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ scopes: authRuntime.scopes }) };
});

const podsResponse = {
  pods: [
    {
      hostname: "gw-pod-1",
      build_version: "v0.83.2",
      applied_token: "tok-a",
      current_token: "tok-a",
      reload_interval_s: 30,
      last_seen: "2026-09-07T01:00:00Z",
      stale: false,
      up_to_date: true,
    },
  ],
  summary: { total: 1, live: 1, stale: 0, converged: 1 },
  stale_s: 90,
  note: "각 게이트웨이 파드의 하트비트·빌드·런타임 설정 수렴 상태입니다.",
};

const probeResponse = {
  results: [
    {
      client: "cursor",
      overall: "fail",
      checks: [
        {
          name: "authorization",
          status: "fail",
          detail: "Proxy API Key 인증 실패.",
          fix: "활성 키를 쓰세요.",
        },
      ],
    },
  ],
  summary: { clients: 1, passing: 0, failing: 1 },
  note: "합성 점검입니다.",
};

function renderPage(route = "/observability/probes"): ReturnType<typeof renderScreen> {
  return renderScreen(<ProbePage />, { path: "/observability/probes", route });
}

describe("ProbePage", () => {
  beforeEach(() => {
    authRuntime.scopes = ["admin:read", "admin:write"];
  });

  it("shows the journey probe form first", async () => {
    mockApi({});
    renderPage();

    expect(await screen.findByRole("heading", { level: 1, name: "진단 프로브" })).toBeVisible();
    expect(screen.getByLabelText(/Proxy API 키/u)).toBeVisible();
    expect(screen.getByText("아직 점검을 실행하지 않았습니다.")).toBeVisible();
  });

  it("restores the pods tab from the URL and renders the map", async () => {
    mockApi({ "GET /admin/pods": () => podsResponse });
    renderPage("/observability/probes?tab=pods");

    const table = await screen.findByRole("table", { name: "게이트웨이 파드 목록" });
    expect(await within(table).findByText("gw-pod-1")).toBeVisible();
    expect(within(table).getByText("최신")).toBeVisible();
  });

  it("shows an empty state when no pod reported a heartbeat", async () => {
    mockApi({
      "GET /admin/pods": () => ({
        ...podsResponse,
        pods: [],
        summary: { total: 0, live: 0, stale: 0, converged: 0 },
      }),
    });
    renderPage("/observability/probes?tab=pods");

    expect(await screen.findByText("등록된 파드가 없습니다.")).toBeVisible();
  });

  it("shows the request id when the pod map fails", async () => {
    mockApi({
      "GET /admin/pods": () => {
        throw apiFailure("pods unavailable", 500, "req_pods_1");
      },
    });
    renderPage("/observability/probes?tab=pods");

    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((alert) => alert.textContent?.includes("요청 ID: req_pods_1"))).toBe(true);
  });

  it("disables the probe run without admin:write", async () => {
    authRuntime.scopes = ["admin:read"];
    mockApi({});
    renderPage();

    expect(await screen.findByRole("button", { name: /점검 실행/u })).toBeDisabled();
    expect(screen.getByText("실행 권한이 없습니다.")).toBeVisible();
  });

  it("runs the journey probe and renders the per-client verdict", async () => {
    const user = userEvent.setup();
    const api = mockApi({ "POST /admin/journey-probe": () => probeResponse });
    renderPage();

    await user.type(await screen.findByLabelText(/Proxy API 키/u), "probe-key");
    for (const label of ["Continue", "Roo Code", "Cline", "Claude Desktop (MCP)", "OpenAI SDK"]) {
      await user.click(screen.getByRole("checkbox", { name: label }));
    }
    await user.click(screen.getByRole("button", { name: /점검 실행/u }));

    await waitFor(() => {
      expect(api.bodies("POST /admin/journey-probe")).toEqual([
        { proxy_key: "probe-key", clients: ["cursor"] },
      ]);
    });
    expect(await screen.findByRole("heading", { level: 2, name: "cursor" })).toBeVisible();
    expect(screen.getByText("Proxy API Key 인증 실패.")).toBeVisible();
    expect(screen.getByText("조치: 활성 키를 쓰세요.")).toBeVisible();
  });

  it("never puts the probe key in the URL", async () => {
    const user = userEvent.setup();
    mockApi({ "POST /admin/journey-probe": () => probeResponse });
    renderPage();

    await user.type(await screen.findByLabelText(/Proxy API 키/u), "vc_sk_secret_probe_key");
    await user.click(screen.getByRole("button", { name: /점검 실행/u }));

    await screen.findByRole("heading", { level: 2, name: "cursor" });
    expect(window.location.search).not.toContain("vc_sk_");
  });

  it("has no automated accessibility violations", async () => {
    mockApi({ "GET /admin/pods": () => podsResponse });
    const { container } = renderPage("/observability/probes?tab=pods");

    await screen.findByRole("table", { name: "게이트웨이 파드 목록" });
    expect((await axe.run(container)).violations).toEqual([]);
  });
});
