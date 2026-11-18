import { fireEvent, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useLocation } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { renderScreen } from "@/test/render";
import { safeReturnTo } from "@/shared/utils/safe-return-to";
import { ConsoleFeatureTable } from "./ConsoleFeatureTable";
import type { ConsoleFeatureRow } from "./settings-utils";
import { readConsoleFilters, filterConsoleFeatures } from "./console-feature-search";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const setting = (value: string) => ({
  key: "test",
  value,
  category: "ui.app.features",
  type: "string",
  description: "",
  is_secret: false,
  read_only: false,
  restart_required: false,
  source: "env" as const,
});
const rows: ConsoleFeatureRow[] = [
  { featureId: "gateway.providers", status: setting("preview"), readonly: setting("true") },
  { featureId: "system.settings", status: setting("stable"), readonly: setting("false") },
  { featureId: "future.feature", status: setting("future"), readonly: setting("invalid") },
];
function Location() {
  return <output aria-label="현재 주소">{useLocation().search}</output>;
}
function setup(
  query = "",
  options: { pending?: boolean; failed?: boolean; rows?: ConsoleFeatureRow[] } = {},
) {
  const onEdit = vi.fn();
  const view = renderScreen(
    <>
      <ConsoleFeatureTable
        rows={options.rows ?? rows}
        pending={options.pending ?? false}
        failed={options.failed ?? false}
        onEdit={onEdit}
      />
      <Location />
    </>,
    { route: `/system/settings?tab=console${query}` },
  );
  return { ...view, onEdit };
}
const table = () => screen.getByRole("table", { name: "기능별 콘솔 전환 상태" });

describe("콘솔 전환 기능 탐색", () => {
  it("combines Korean name, status and explicit write-block filters; preserves unrelated state on reset", async () => {
    setup("&telemetry_days=30&q=기존조건&setting=ui.app.enabled");
    const user = userEvent.setup();
    await user.type(screen.getByRole("textbox", { name: "전환 기능 검색" }), "공급자");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(within(table()).getByText("AI 공급자")).toBeVisible();
    expect(within(table()).queryByText("시스템 설정")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("전환 상태 필터"), "preview");
    await user.selectOptions(screen.getByLabelText("쓰기 차단 설정"), "false");
    expect(within(table()).getByText(/조회 조건에 맞는 기능이 없습니다/)).toBeVisible();
    expect(screen.getByText(/등록된 기능 3개 · 조건에 맞는 기능 0개/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "전환 조회 조건 초기화" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(4);
    const location = screen.getByLabelText("현재 주소").textContent ?? "";
    expect(location).toContain("telemetry_days=30");
    expect(location).toContain("setting=ui.app.enabled");
    expect(location).not.toContain("console_");
  });

  it("restores direct filters, keeps editor identity and the actual trigger, and has no axe violations", async () => {
    const view = setup("&console_q=GATEWAY&console_status=preview&console_readonly=true");
    const button = within(table()).getByRole("button", { name: "AI 공급자 전환 설정 편집" });
    await userEvent.setup().click(button);
    expect(view.onEdit).toHaveBeenCalledWith(rows[0], button);
    expect(screen.getByRole("textbox", { name: "전환 기능 검색" })).toHaveValue("GATEWAY");
    expect((await axe.run(view.container)).violations).toEqual([]);
    expect(
      safeReturnTo(
        "/app/system/settings?tab=console&console_q=GATEWAY&console_status=preview&console_readonly=true",
      ),
    ).toBe("/system/settings?tab=console&console_q=GATEWAY&console_status=preview&console_readonly=true");
  });

  it("preserves Korean composition until explicit search and never writes a credential to the URL", async () => {
    setup();
    const input = screen.getByRole("textbox", { name: "전환 기능 검색" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "공급" } });
    expect(within(table()).getAllByRole("row")).toHaveLength(4);
    fireEvent.compositionEnd(input, { data: "공급" });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
    await user.clear(input);
    await user.type(input, "vc_sk_do_not_persist_this_test_value");
    await user.click(screen.getByRole("button", { name: "검색" }));
    expect(screen.getByText(/검색어는 비밀정보와 제어문자 없이/)).toBeVisible();
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("vc_sk_");
    expect(input).toHaveFocus();
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
  });

  it.each([
    "&console_q=a&console_q=b",
    "&console_status=oops",
    "&console_readonly=maybe",
    "&console_q=vc_sk_do_not_persist_this_test_value",
  ])("requires explicit reset for invalid direct conditions: %s", async (query) => {
    setup(query);
    expect(screen.getByText(/전환 기능의 조회 조건을 확인할 수 없습니다/)).toBeVisible();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByLabelText("현재 주소")).not.toHaveTextContent("vc_sk_");
    await userEvent.setup().click(screen.getByRole("button", { name: "전환 조회 조건 초기화" }));
    expect(table()).toBeVisible();
  });

  it("separates unknown settings from an explicit write allowance", () => {
    setup("&console_status=unknown&console_readonly=unknown");
    expect(within(table()).getByRole("rowheader", { name: /future\.feature/ })).toBeVisible();
    expect(within(table()).queryByText("쓰기 허용")).not.toBeInTheDocument();
    expect(within(table()).getAllByRole("row")).toHaveLength(2);
  });

  it.each([
    { pending: true, failed: false, message: /콘솔 전환 설정을 불러오는 중입니다/ },
    { pending: false, failed: true, message: /조회 실패로 기능 수를 확인할 수 없습니다/ },
    { pending: false, failed: false, message: /전환 설정을 제공하는 기능이 없습니다/ },
  ])("distinguishes data states: %o", (state) => {
    setup("", { ...state, rows: [] });
    expect(screen.getAllByText(state.message).length).toBeGreaterThan(0);
    if (state.failed) expect(screen.queryByText(/등록된 기능 0개/)).not.toBeInTheDocument();
  });

  it("does not search setting values or conflate a preview status with the independent write flag", () => {
    const filter = readConsoleFilters(new URLSearchParams("console_q=invalid"), []);
    expect(filterConsoleFeatures(rows, filter)).toEqual([]);
    const ro = [
      { featureId: "gateway.providers", status: setting("preview_read_only"), readonly: setting("false") },
    ];
    expect(
      filterConsoleFeatures(ro, readConsoleFilters(new URLSearchParams("console_readonly=true"), [])),
    ).toEqual([]);
  });
});
