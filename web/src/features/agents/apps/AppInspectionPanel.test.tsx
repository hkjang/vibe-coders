import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppInspectionPanel } from "./AppInspectionPanel";
import { appRunPlanSchema, appValidationSchema } from "@/shared/api/domains/agents.schemas";
import { tokenStore } from "@/shared/auth/token-store";
import { FeatureAccessContext } from "@/shared/feature-access/context";
import { apiFailure, mockApi } from "@/test/api";
import { renderScreen } from "@/test/render";

const runtime = vi.hoisted(() => ({ scopes: ["admin:read", "admin:write"], id: "one", team: "team-one" }));
vi.mock("@/app/auth/AuthProvider", async () => {
  const { testAuth } = await import("@/test/auth");
  return {
    useAuth: () => testAuth({ scopes: runtime.scopes, user: { id: runtime.id, team_id: runtime.team } }),
  };
});
const component = { kind: "model", ref: "test-model", label: "검토 모델" };
const app = { id: "app_one", title: "검토 앱", components: [component] };
const validation = {
  ok: true,
  checks: [{ ...component, resolved: true, detail: "모델 참조" }],
  warnings: [],
  allowed_models: ["test-model"],
};
const plan = {
  app_id: app.id,
  run_id: "plan_one",
  title: app.title,
  status: "planned",
  plan: [{ ...component, resolved: true, detail: "모델 참조", action: "model" }],
};
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function Host() {
  const [selected, setSelected] = useState(app);
  const [open, setOpen] = useState(true);
  const [readOnly, setReadOnly] = useState(false);
  const [permitted, setPermitted] = useState(true);
  const [paused, setPaused] = useState(false);
  const [, update] = useState(0);
  return (
    <FeatureAccessContext.Provider
      value={{ featureId: "agents.apps", permitted, readOnly, status: "preview" }}
    >
      <button onClick={() => setSelected(app)}>앱 A</button>
      <button onClick={() => setSelected({ ...app, id: "app_two" })}>앱 B</button>
      <button onClick={() => setSelected({ ...app, components: [{ ...component, ref: "new-model" }] })}>
        구성 변경
      </button>
      <button onClick={() => setOpen((value) => !value)}>열기 닫기</button>
      <button onClick={() => setReadOnly(true)}>읽기 전용 전환</button>
      <button onClick={() => setPermitted(false)}>접근 차단</button>
      <button onClick={() => setPaused(true)}>권한 편집 중</button>
      <button onClick={() => update((value) => value + 1)}>인증 변경 반영</button>
      {open ? <AppInspectionPanel app={selected} disabled={paused} /> : null}
    </FeatureAccessContext.Provider>
  );
}
function setup(validate: () => unknown = () => validation, run: () => unknown = () => plan) {
  const api = mockApi({
    "POST /admin/apps/app_one/validate": validate,
    "POST /v1/apps/app_one/run": run,
    "POST /admin/apps/app_two/validate": () => validation,
    "POST /v1/apps/app_two/run": () => ({ ...plan, app_id: "app_two", run_id: "plan_two" }),
  });
  return { api, user: userEvent.setup(), ...renderScreen(<Host />) };
}
beforeEach(() => {
  runtime.scopes = ["admin:read", "admin:write"];
  runtime.id = "one";
  runtime.team = "team-one";
  tokenStore.clearAll();
});

describe("업무 앱 검증·계획의 대상과 수명", () => {
  it("참조 검증과 실제 실행을 구분한다", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "검증" }));
    expect(await screen.findByText(/실제 실행 성공을 보장하지 않습니다/u)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText("계획 생성 · 실제 실행 안 함")).toBeVisible();
    expect(screen.getByText("plan_one")).toBeVisible();
  });
  it.each(["앱 B", "구성 변경", "열기 닫기"])("%s 후 늦은 응답을 버린다", async (action) => {
    const pending = deferred();
    const { user } = setup(() => pending.promise);
    await user.click(screen.getByRole("button", { name: "검증" }));
    await user.click(screen.getByRole("button", { name: action }));
    if (action === "앱 B") await user.click(screen.getByRole("button", { name: "앱 A" }));
    if (action === "열기 닫기") await user.click(screen.getByRole("button", { name: action }));
    await act(async () => pending.resolve(validation));
    expect(screen.queryByRole("heading", { name: "검증 결과" })).not.toBeInTheDocument();
  });
  it("새 앱의 계획을 이전 앱의 늦은 계획으로 덮어쓰지 않는다", async () => {
    const pending = deferred();
    const { user, client } = setup(undefined, () => pending.promise);
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    await user.click(screen.getByRole("button", { name: "앱 B" }));
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText("plan_two")).toBeVisible();
    expect(invalidate).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve(plan));
    expect(screen.queryByText("plan_one")).not.toBeInTheDocument();
    expect(screen.getByText("plan_two")).toBeVisible();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
  it.each(["계정", "팀", "조회 권한", "세션"])("%s 변경 뒤 응답과 오류를 노출하지 않는다", async (change) => {
    const pending = deferred();
    const { user } = setup(undefined, () => pending.promise);
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    if (change === "계정") runtime.id = "two";
    if (change === "팀") runtime.team = "team-two";
    if (change === "조회 권한") runtime.scopes = ["admin:write"];
    if (change === "세션") act(() => tokenStore.clearAll());
    await user.click(screen.getByRole("button", { name: "인증 변경 반영" }));
    await act(async () => pending.resolve(plan));
    expect(screen.queryByText("plan_one")).not.toBeInTheDocument();
    expect(screen.queryByText("실행 계획을 확인하지 못했습니다.")).not.toBeInTheDocument();
  });
  it.each(["접근 차단", "권한 편집 중"])("%s 뒤 추가 요청을 막는다", async (action) => {
    const { user, api } = setup();
    await user.click(screen.getByRole("button", { name: action }));
    for (const name of ["검증", "실행 계획 생성"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button);
    }
    expect(api.calls).toHaveLength(0);
  });
  it("읽기 전용에서는 참조 검증만 허용하고 계획 이력 생성을 막는다", async () => {
    const { user, api } = setup();
    await user.click(screen.getByRole("button", { name: "읽기 전용 전환" }));
    expect(screen.getByRole("button", { name: "실행 계획 생성" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "검증" }));
    expect(await screen.findByRole("heading", { name: "검증 결과" })).toBeVisible();
    expect(api.calls).toHaveLength(1);
  });
  it("관리자 쓰기 권한 없이 검증하지 않지만 계획 기록은 기존 API 권한을 따른다", async () => {
    runtime.scopes = ["admin:read"];
    const { user } = setup();
    expect(screen.getByRole("button", { name: "검증" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText("plan_one")).toBeVisible();
  });
  it("진행 중 두 작업과 중복 클릭을 막고 인증 재전송을 금지한다", async () => {
    const pending = deferred();
    const { api, user } = setup(undefined, () => pending.promise);
    await user.dblClick(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(screen.getByRole("button", { name: "검증" })).toBeDisabled();
    expect(api.calls).toHaveLength(1);
    expect(api.spy.mock.calls[0]?.[1]).toMatchObject({ retryUnauthorized: false });
    await act(async () => pending.resolve(plan));
  });
  it.each([401, 403])("권한 오류 %i 후 기존 결과를 숨기고 요청을 중단한다", async (status) => {
    const { user } = setup(undefined, () => {
      throw apiFailure("denied", status);
    });
    await user.click(screen.getByRole("button", { name: "검증" }));
    expect(await screen.findByRole("heading", { name: "검증 결과" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText("접근 권한을 다시 확인하세요.")).toBeVisible();
    expect(screen.queryByRole("heading", { name: "검증 결과" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "실행 계획 생성" })).toBeDisabled();
  });
  it.each([
    {},
    { ...plan, app_id: "other" },
    { ...plan, plan: [] },
    { ...plan, status: "ok" },
    { ...plan, plan: [{ ...plan.plan[0], ref: "other" }] },
  ])("일치하지 않는 계획 응답을 성공으로 표시하지 않는다", async (response) => {
    const { user, api } = setup(undefined, () => response);
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText("실행 계획을 확인하지 못했습니다.")).toBeVisible();
    expect(screen.queryByText("plan_one")).not.toBeInTheDocument();
    expect(api.calls).toHaveLength(1);
  });
  it("일반 오류의 요청 ID와 중복 이력 주의를 제공한다", async () => {
    const { user } = setup(undefined, () => {
      throw apiFailure("failed", 500, "req_plan");
    });
    await user.click(screen.getByRole("button", { name: "실행 계획 생성" }));
    expect(await screen.findByText(/요청 ID: req_plan/u)).toHaveTextContent("새 이력이 추가될 수 있습니다.");
  });
  it("빈 구성은 정상 검증 완료가 아니다", async () => {
    const { user } = setup(() => ({ ...validation, checks: [] }));
    await user.click(screen.getByRole("button", { name: "검증" }));
    expect(await screen.findByText("검증에 실패했습니다.")).toBeVisible();
  });
  it("요약과 개별 검증 결과가 모순되면 중단한다", async () => {
    const { user } = setup(() => ({ ...validation, ok: false }));
    await user.click(screen.getByRole("button", { name: "검증" }));
    await waitFor(() => expect(screen.getByText("검증에 실패했습니다.")).toBeVisible());
  });
});

describe("실제 서버 응답의 필수 필드", () => {
  it.each([
    {},
    { ...validation, ok: null },
    { ...validation, checks: [{ ...validation.checks[0], resolved: undefined }] },
  ])("검증 누락을 거부한다", (value) => expect(appValidationSchema.safeParse(value).success).toBe(false));
  it.each([{}, { ...plan, run_id: "" }, { ...plan, plan: [{ ...plan.plan[0], resolved: undefined }] }])(
    "계획 누락을 거부한다",
    (value) => expect(appRunPlanSchema.safeParse(value).success).toBe(false),
  );
});
