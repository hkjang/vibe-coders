import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { ConsoleActionsLauncher } from "./ConsoleActionsLauncher";
import { actionSuccessRate } from "./action-labels";
import { uiActionsSummarySchema } from "@/shared/api/domains/ui-actions";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { mockApi, apiFailure } from "@/test/api";
import { renderScreen } from "@/test/render";
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth({ backendVersion: "v0.86.181" }) };
});
const row = {
  feature_id: "gateway.providers",
  action: "save",
  ui_version: "v0.86.181",
  success: 3,
  rejected: 1,
  unknown: 10,
};
const summary = {
  enabled: true,
  days: 7,
  from: "2026-11-13T00:00:00Z",
  to: "2026-11-20T00:00:00Z",
  retention_days: 30,
  event_limit: 10_000,
  group_limit: 100,
  success: 3,
  rejected: 1,
  unknown: 10,
  other: { success: 0, rejected: 0, unknown: 0 },
  groups: [row],
};
function renderLauncher() {
  return renderScreen(
    <FeatureAccessContext.Provider
      value={{ featureId: "system.settings", permitted: true, readOnly: false, status: "preview" }}
    >
      <ConsoleActionsLauncher />
    </FeatureAccessContext.Provider>,
  );
}
describe("console action evidence", () => {
  it("excludes unconfirmed outcomes from the rate and provides accessible lazy-loaded Korean results", async () => {
    const { calls } = mockApi({ "GET /admin/ui-actions/summary": () => summary });
    const user = userEvent.setup();
    renderLauncher();
    expect(calls).toHaveLength(0);
    const trigger = screen.getByRole("button", { name: "작업 결과 열기" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "콘솔 작업 결과" });
    expect(
      await within(dialog).findByText(/완료율 75% · 완료 3건 · 거부 1건 · 확인 불가 10건/),
    ).toBeVisible();
    expect(within(dialog).getByRole("region", { name: "콘솔 기능별 작업 결과" })).toHaveTextContent("저장");
    expect((await axe.run(dialog)).violations).toEqual([]);
    await user.selectOptions(within(dialog).getByLabelText("작업 조회 기간"), "30");
    await waitFor(() =>
      expect(calls.some((call) => (call.options.query as { days?: number })?.days === 30)).toBe(true),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
  });
  it("preserves last good evidence on connection failure and never displays raw server details", async () => {
    let failure = false;
    mockApi({
      "GET /admin/ui-actions/summary": () => {
        if (failure) throw apiFailure("private payload", 503, "req-test");
        return { ...summary, enabled: false, success: 0, rejected: 0, unknown: 0, groups: [] };
      },
    });
    const user = userEvent.setup();
    renderLauncher();
    await user.click(screen.getByRole("button", { name: "작업 결과 열기" }));
    expect(await screen.findByText("현재 수집이 꺼져 있습니다.")).toBeVisible();
    expect(screen.getByText("이 기간에 관측된 작업이 없습니다.")).toBeVisible();
    failure = true;
    await user.click(screen.getByRole("button", { name: "작업 결과 새로고침" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("마지막 정상 조회 결과");
    expect(screen.getByRole("alert")).toHaveTextContent("req-test");
    expect(screen.queryByText("private payload")).not.toBeInTheDocument();
  });
  it("shows no percentage when no outcome is confirmed and rejects inconsistent or private categories", () => {
    expect(actionSuccessRate({ success: 0, rejected: 0 })).toBe("확인된 결과 없음");
    expect(uiActionsSummarySchema.safeParse(summary).success).toBe(true);
    for (const bad of [
      { ...summary, success: 4 },
      { ...summary, unknown: 9 },
      { ...summary, groups: [{ ...row, action: "private-request" }] },
      { ...summary, groups: [{ ...row, ui_version: "private-branch" }] },
      { ...summary, groups: [{ ...row, payload: "private" }] },
      { ...summary, groups: [row, row], success: 6, rejected: 2, unknown: 20 },
      { ...summary, success: 10_000, unknown: 10_000 },
    ])
      expect(uiActionsSummarySchema.safeParse(bad).success).toBe(false);
  });
});
