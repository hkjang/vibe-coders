import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";

import { ConsoleUsagePanel } from "@/features/system/settings/ConsoleUsagePanel";
import { uiTelemetrySummarySchema } from "@/shared/api/domains/ui-telemetry";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const summary = {
  enabled: true,
  days: 7,
  from: "2026-09-22T00:00:00Z",
  to: "2026-09-29T00:00:00Z",
  retention_days: 30,
  visit_limit: 100_000,
  features: [{ feature_id: "gateway.providers", visits: 20, legacy_opens: 5 }],
};

describe("ConsoleUsagePanel", () => {
  it("shows Korean per-feature counts and a non-user rate with an accessible table", async () => {
    mockApi({ "GET /admin/ui-telemetry/summary": () => summary });
    const { container } = renderScreen(<ConsoleUsagePanel />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("AI 공급자")).toBeVisible();
    expect(within(table).getByText("25%")).toBeVisible();
    expect(screen.getByText(/순사용자 수나 전체 채택률이 아닙니다/)).toBeVisible();
    expect((await axe.run(container)).violations).toEqual([]);
  });

  it("keeps the selected period in the URL and query", async () => {
    const queries: unknown[] = [];
    mockApi({
      "GET /admin/ui-telemetry/summary": (options) => {
        queries.push(options?.query);
        return { ...summary, days: (options?.query as { days: number }).days };
      },
    });
    renderScreen(<ConsoleUsagePanel />, { route: "/system/settings?tab=console&telemetry_days=30" });
    await screen.findByRole("table");
    expect(queries).toEqual([{ days: 30 }]);
    await userEvent.setup().selectOptions(screen.getByLabelText("조회 기간"), "7");
    expect(await screen.findByRole("table")).toBeVisible();
    expect(queries).toContainEqual({ days: 7 });
  });

  it("shows off/empty without claiming a zero fallback rate", async () => {
    mockApi({ "GET /admin/ui-telemetry/summary": () => ({ ...summary, enabled: false, features: [] }) });
    renderScreen(<ConsoleUsagePanel />);
    expect(await screen.findByText(/수집 꺼짐/)).toHaveTextContent("비율 산정 불가");
    expect(screen.getByText(/현재 수집을 중지했습니다/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("isolates failures, shows the request ID and retries explicitly", async () => {
    let calls = 0;
    mockApi({
      "GET /admin/ui-telemetry/summary": () => {
        if (++calls === 1) throw apiFailure("private server details", 503, "req-usage");
        return summary;
      },
    });
    renderScreen(<ConsoleUsagePanel />);
    expect(await screen.findByText(/요청 ID: req-usage/)).toBeVisible();
    expect(screen.queryByText("private server details")).not.toBeInTheDocument();
    expect(calls).toBe(1);
    await userEvent.setup().click(screen.getByRole("button", { name: "관측 결과 새로고침" }));
    expect(await screen.findByRole("table")).toBeVisible();
  });

  it("rejects impossible rates, oversized counters and unsupported periods", () => {
    expect(uiTelemetrySummarySchema.safeParse(summary).success).toBe(true);
    for (const data of [
      { ...summary, features: [{ feature_id: "overview", visits: 1, legacy_opens: 2 }] },
      { ...summary, features: [{ feature_id: "overview", visits: 100_001, legacy_opens: 0 }] },
      { ...summary, days: 365 },
    ])
      expect(uiTelemetrySummarySchema.safeParse(data).success).toBe(false);
  });

  it("keeps keyboard focus during refresh and ignores repeated activation", async () => {
    let resolveRefresh!: (value: typeof summary) => void;
    const pending = new Promise<typeof summary>((resolve) => {
      resolveRefresh = resolve;
    });
    let calls = 0;
    mockApi({ "GET /admin/ui-telemetry/summary": () => (++calls === 1 ? summary : pending) });
    renderScreen(<ConsoleUsagePanel />);
    await screen.findByRole("table");
    const user = userEvent.setup();
    const refresh = screen.getByRole("button", { name: "관측 결과 새로고침" });
    refresh.focus();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(refresh).toHaveAttribute("aria-disabled", "true"));
    expect(refresh).toHaveFocus();
    expect(refresh).not.toBeDisabled();
    await user.keyboard("{Enter}");
    expect(calls).toBe(2);
    await act(async () => resolveRefresh(summary));
    await waitFor(() => expect(refresh).toHaveAttribute("aria-disabled", "false"));
    expect(refresh).toHaveFocus();
  });
});
