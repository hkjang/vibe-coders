import { fireEvent, act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { RedTeamEmergencyPanel } from "./RedTeamEmergencyPanel";
import { redTeamEmergencySchema } from "@/shared/api/domains/redteam";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return { useAuth: () => testAuth() };
});

const baseHandlers = {};
const post = "POST /admin/redteam/kill-switch";
const observed = {
  enabled: false,
  scope: "responding_process",
  instance_ref: "process_0123456789abcdef",
  review_token: "0123456789abcdef0123456789abcdef",
  observed_at: "2026-10-12T00:00:00Z",
};

function mount(readOnly = false) {
  return renderScreen(
    <FeatureAccessContext.Provider value={{ featureId: "security.redteam", permitted: true, readOnly }}>
      <RedTeamEmergencyPanel canWrite />
    </FeatureAccessContext.Provider>,
    { path: "/redteam", route: "/redteam?tab=runtime" },
  );
}

describe("레드팀 emergency control safety regression", () => {
  it.each([{}, { enabled: null }])("does not invent running state from missing data: %j", (value) => {
    expect(redTeamEmergencySchema.safeParse(value).success).toBe(false);
  });

  it.each([true, false])("preserves explicit legacy acknowledgment state: %s", (enabled) => {
    expect(redTeamEmergencySchema.parse({ enabled })).toEqual({ enabled });
    expect(redTeamEmergencySchema.parse({ enabled })).toEqual({
      enabled,
    });
  });

  it("does not resume until the operator separately confirms the change", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/redteam/kill-switch": () => ({ ...observed, enabled: true }),
      [post]: () => ({ enabled: false }),
    });
    mount();
    const button = await screen.findByRole("button", { name: "레드팀 처리 재개 검토" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    expect(api.bodies(post)).toEqual([]);
    expect(screen.getByRole("dialog")).toBeVisible();
  });

  it("blocks changes when the current state could not be read", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/redteam/kill-switch": () => {
        throw apiFailure("Synthetic state unavailable", 503);
      },
    });
    mount();
    await waitFor(() =>
      expect(api.calls.some((call) => call.key === "GET /admin/redteam/kill-switch")).toBe(true),
    );
    expect(screen.getByRole("button", { name: "레드팀 처리 중지 검토" })).toBeDisabled();
    expect(await screen.findByText("현재 레드팀 상태를 확인하지 못했습니다.")).toBeVisible();
  });

  it("keeps migration read-only mode read-only for an administrator", async () => {
    mockApi({
      ...baseHandlers,
      "GET /admin/redteam/kill-switch": () => observed,
    });
    mount(true);
    expect(await screen.findByRole("button", { name: "레드팀 처리 중지 검토" })).toBeDisabled();
  });

  it("requires a reason and a typed target before stopping", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/redteam/kill-switch": () => observed,
      [post]: () => ({ enabled: true }),
    });
    mount();
    const button = await screen.findByRole("button", { name: "레드팀 처리 중지 검토" });
    await waitFor(() => expect(button).toBeEnabled());
    await userEvent.click(button);
    const dialog = await screen.findByRole("dialog", { name: "레드팀 처리 중지" });
    expect(within(dialog).getByRole("button", { name: "중지" })).toBeDisabled();
    expect(api.bodies(post)).toEqual([]);
  });

  it.each([false, true])(
    "submits one reviewed change with its reason and revision: stopped=%s",
    async (enabled) => {
      let state = { ...observed, enabled, reason: "" };
      const api = mockApi({
        ...baseHandlers,
        "GET /admin/redteam/kill-switch": () => state,
        [post]: ({ body }) => {
          const change = body as { enabled: boolean; reason: string };
          state = { ...state, ...change, review_token: "abcdef0123456789abcdef0123456789" };
          return state;
        },
      });
      mount();
      const label = enabled ? "레드팀 처리 재개" : "레드팀 처리 중지";
      const button = await screen.findByRole("button", { name: `${label} 검토` });
      await waitFor(() => expect(button).toBeEnabled());
      const user = userEvent.setup();
      await user.click(button);
      const dialog = screen.getByRole("dialog", { name: label });
      const submit = within(dialog).getByRole("button", { name: enabled ? "재개" : "중지" });
      await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "공개 합성 운영 확인");
      expect(submit).toBeDisabled();
      await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), label);
      await user.click(submit);
      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(api.bodies(post)).toEqual([
        { enabled: !enabled, reason: "공개 합성 운영 확인", expected_review_token: observed.review_token },
      ]);
      const call = api.spy.mock.calls.find(([endpoint]) => endpoint.method === "POST");
      expect(call?.[1]).toMatchObject({ retryUnauthorized: false });
    },
  );

  it("shows an older server state without exposing unsupported reviewed writes", async () => {
    mockApi({ ...baseHandlers, "GET /admin/redteam/kill-switch": () => ({ enabled: false }) });
    mount();
    expect(await screen.findByText("서버의 안전한 변경 검토 지원이 필요합니다.")).toBeVisible();
    expect(screen.getByRole("button", { name: "레드팀 처리 중지 검토" })).toBeDisabled();
    expect(screen.queryByRole("switch")).not.toBeInTheDocument();
  });

  it("never replays an uncertain write, including after a manual state read", async () => {
    const api = mockApi({
      ...baseHandlers,
      "GET /admin/redteam/kill-switch": () => observed,
      [post]: () => {
        throw apiFailure("Synthetic response lost", 503);
      },
    });
    mount();
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "레드팀 처리 중지 검토" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "공개 합성 변경");
    await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), "레드팀 처리 중지");
    await user.click(within(dialog).getByRole("button", { name: "중지" }));
    expect(await screen.findByText("처리 결과 확인이 필요합니다.")).toBeVisible();
    expect(within(dialog).getByRole("button", { name: "중지" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "현재 상태만 다시 조회" }));
    await waitFor(() =>
      expect(api.calls.filter((call) => call.key === "GET /admin/redteam/kill-switch").length).toBe(2),
    );
    expect(within(dialog).getByRole("button", { name: "중지" })).toBeDisabled();
    expect(api.bodies(post)).toHaveLength(1);
  });

  it("invalidates consent when the same state is refreshed during the review", async () => {
    const api = mockApi({ ...baseHandlers, "GET /admin/redteam/kill-switch": () => observed });
    const { client } = mount();
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: "레드팀 처리 중지 검토" });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("변경 사유", { exact: false }), "공개 합성 변경");
    await user.type(within(dialog).getByLabelText("확인 문구", { exact: false }), "레드팀 처리 중지");
    await act(async () => {
      await client.refetchQueries({ queryKey: ["redteam", "kill-switch"] });
    });
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "중지" })).toBeDisabled());
    expect(api.bodies(post)).toEqual([]);
  });
  it("사유 길이 초과를 한글로 안내하고 보충 문자 1,000자를 허용한다", async () => {
    let state = { ...observed, reason: "" };
    const api = mockApi({
      "GET /admin/redteam/kill-switch": () => state,
      [post]: ({ body }) => {
        const change = body as { enabled: boolean; reason: string };
        state = { ...state, ...change, review_token: "a".repeat(32) };
        return state;
      },
    });
    mount();
    const trigger = screen.getByRole("button", { name: "레드팀 처리 중지 검토" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.click(trigger);
    const dialog = screen.getByRole("dialog");
    const reason = within(dialog).getByRole("textbox", { name: "변경 사유" });
    fireEvent.change(reason, { target: { value: "😀".repeat(1001) } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "확인 문구" }), {
      target: { value: "레드팀 처리 중지" },
    });
    await userEvent.click(within(dialog).getByRole("button", { name: "중지" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(
      "변경 사유는 1,000자 이내로 입력하세요.",
    );
    expect(api.bodies(post)).toEqual([]);
    fireEvent.change(reason, { target: { value: "😀".repeat(1000) } });
    await userEvent.click(within(dialog).getByRole("button", { name: "중지" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(api.bodies(post)).toEqual([
      { enabled: true, reason: "😀".repeat(1000), expected_review_token: observed.review_token },
    ]);
  });
});
