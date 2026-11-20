import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { ConsoleDiagnosticsLauncher } from "./ConsoleDiagnosticsLauncher";
import { uiDiagnosticsSummarySchema } from "@/shared/api/domains/ui-diagnostics";
import { mockApi, apiFailure } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ backendVersion: "v0.86.180" }) };
});

const row = {
  feature_id: "observability.requests",
  kind: "api_error",
  ui_version: "v0.86.180",
  endpoint: "/admin/requests/{id}/io",
  method: "GET",
  status: 503,
  request_id: "",
  failure: "http",
  boundary: "",
};
const summary = {
  enabled: true,
  days: 7,
  from: "2026-11-13T00:00:00Z",
  to: "2026-11-20T00:00:00Z",
  retention_days: 30,
  event_limit: 10_000,
  group_limit: 100,
  recent_limit: 20,
  total: 2,
  other_group_events: 0,
  groups: [{ ...row, events: 2 }],
  recent: [{ ...row, received_at: "2026-11-19T00:00:00Z", request_id: "trace_" + "a".repeat(32) }],
};

describe("console diagnostic review", () => {
  it("loads only when opened, shows Korean bounded evidence, supports keyboard close and restores focus", async () => {
    const { calls } = mockApi({ "GET /admin/ui-diagnostics/summary": () => summary });
    const user = userEvent.setup();
    renderScreen(<ConsoleDiagnosticsLauncher />);
    expect(calls).toHaveLength(0);
    const trigger = screen.getByRole("button", { name: "오류 관측 열기" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "콘솔 오류 관측" });
    expect(await within(dialog).findByText(/관측된 오류 2건/)).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "콘솔 오류 유형별 집계" })).toHaveTextContent(
      "서버 오류 응답",
    );
    expect(within(dialog).getByRole("region", { name: "최근 콘솔 오류" })).toHaveTextContent(
      "trace_" + "a".repeat(32),
    );
    expect((await axe.run(dialog)).violations).toEqual([]);
    await user.selectOptions(within(dialog).getByLabelText("오류 조회 기간"), "30");
    await waitFor(() =>
      expect(calls.some((call) => (call.options.query as { days?: number })?.days === 30)).toBe(true),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("distinguishes disabled collection, empty observations and a failed refresh without erasing good data", async () => {
    let failure = false;
    const user = userEvent.setup();
    mockApi({
      "GET /admin/ui-diagnostics/summary": () => {
        if (failure) throw apiFailure("private server detail", 503, "req-test");
        return { ...summary, enabled: false, total: 0, groups: [], recent: [] };
      },
    });
    renderScreen(<ConsoleDiagnosticsLauncher />);
    await user.click(screen.getByRole("button", { name: "오류 관측 열기" }));
    expect(await screen.findByText("현재 수집이 꺼져 있습니다.")).toBeVisible();
    expect(screen.getByText("이 기간에 관측된 오류가 없습니다.")).toBeVisible();
    failure = true;
    await user.click(screen.getByRole("button", { name: "오류 관측 새로고침" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("마지막 정상 조회 결과");
    expect(screen.getByRole("alert")).toHaveTextContent("req-test");
    expect(screen.queryByText("private server detail")).not.toBeInTheDocument();
  });

  it("rejects arbitrary paths, identifiers, version labels, payload fields and inconsistent bounds", () => {
    expect(uiDiagnosticsSummarySchema.safeParse(summary).success).toBe(true);
    for (const bad of [
      { ...summary, total: 3 },
      { ...summary, groups: [{ ...summary.groups[0], endpoint: "/admin/requests/private/io" }] },
      { ...summary, groups: [{ ...summary.groups[0], ui_version: "private-user" }] },
      { ...summary, recent: [{ ...summary.recent[0], request_id: "private-key" }] },
      { ...summary, recent: [{ ...summary.recent[0], message: "private-prompt" }] },
      { ...summary, recent: Array.from({ length: 21 }, () => summary.recent[0]) },
    ])
      expect(uiDiagnosticsSummarySchema.safeParse(bad).success).toBe(false);
  });
});
