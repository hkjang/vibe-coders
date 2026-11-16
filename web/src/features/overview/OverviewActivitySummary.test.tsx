import { useLayoutEffect, useState } from "react";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { apiClient } from "@/shared/api/client";
import { AppError } from "@/shared/api/error";
import {
  alertActivitySchema,
  auditActivitySchema,
  incidentActivitySchema,
} from "@/shared/api/domains/activity-summaries";
import { testAuth } from "@/test/auth";
import { renderScreen } from "@/test/render";
import { FeatureAccessHarness } from "@/test/feature-access";
import { alertActivity, auditActivity, incidentActivity } from "../../../tests/fixtures/activity-summaries";
import { OverviewRefreshContext } from "./overview-refresh-context";
import { OverviewActivitySummary } from "./OverviewActivitySummary";

const state = vi.hoisted(() => ({ auth: {} as ReturnType<typeof testAuth> }));
vi.mock("@/app/auth/AuthProvider", () => ({ useAuth: () => state.auth }));
vi.mock("@/shared/api/client", () => ({ apiClient: { request: vi.fn() } }));
const read = vi.mocked(apiClient.request);
let fail = 0;
let empty = false;
let refreshers = new Set<() => void>();
beforeEach(() => {
  state.auth = testAuth({ backendVersion: "v0.86.129" });
  fail = 0;
  empty = false;
  refreshers = new Set();
  read.mockReset().mockImplementation(async (endpoint) => {
    if (endpoint.path === "/admin/incidents/summary")
      return (
        empty ? { ...incidentActivity, total: 0, current_hour: 0, signals: [] } : incidentActivity
      ) as never;
    if (endpoint.path === "/admin/alerts/summary") {
      if (fail)
        throw new AppError("private-error", { kind: "http", status: fail, requestId: "activity-request" });
      return (empty ? { ...alertActivity, events: [], has_more: false } : alertActivity) as never;
    }
    if (endpoint.path === "/admin/audit-logs/summary")
      return (empty ? { ...auditActivity, changes: [], has_more: false } : auditActivity) as never;
    throw new Error("Unexpected read");
  });
});
function setup() {
  let setRange: (range: "24h" | "7d") => void = () => undefined;
  let refresh: () => void = () => undefined;
  function Host() {
    const [range, updateRange] = useState<"24h" | "7d">("24h");
    const [, update] = useState(0);
    useLayoutEffect(() => {
      setRange = updateRange;
      refresh = () => update((n) => n + 1);
    }, []);
    return (
      <FeatureAccessHarness featureId="overview" readOnly>
        <OverviewRefreshContext value={refreshers}>
          <button
            onClick={() => {
              for (const fn of refreshers) fn();
            }}
          >
            전체 새로고침
          </button>
          <OverviewActivitySummary range={range} interval={false} />
        </OverviewRefreshContext>
      </FeatureAccessHarness>
    );
  }
  return {
    ...renderScreen(<Host />),
    setRange: (range: "24h" | "7d") => act(() => setRange(range)),
    refresh: () => act(refresh),
  };
}
function widget(name: string) {
  const article = screen.getByRole("heading", { name }).closest("article");
  if (!article) throw new Error("Missing activity widget");
  return within(article);
}

it("사고 확정과 시간대 신호를 구분하고 원문 없이 세 요약만 조회한다", async () => {
  setup();
  await screen.findByText("기본 공급자");
  expect(screen.getByText(/진행 중인 장애 확정이나 복구 여부/)).toBeVisible();
  expect(screen.getByText("전송 오류", { exact: true })).toBeVisible();
  expect(screen.getByText("전송 성공", { exact: true })).toBeVisible();
  expect(screen.getByText("전송 확인 없음", { exact: true })).toBeVisible();
  expect(widget("최근 관리 작업").getByText("정책·승인")).toBeVisible();
  expect(screen.getByRole("link", { name: "전체 변경 이력 열기" })).toHaveAttribute(
    "href",
    "/system/settings?tab=audit",
  );
  expect(read).toHaveBeenCalledTimes(3);
  const help = screen.getByText("집계 기준 보기");
  await userEvent.click(help);
  expect(screen.getByText(/UTC 기준 시간당/)).toBeVisible();
});
it("선택 기간을 세 요약에 함께 적용하고 빈 기록을 정상 판정과 구분한다", async () => {
  const view = setup();
  await screen.findByText("기본 공급자");
  empty = true;
  view.setRange("7d");
  await screen.findByText("임계치 초과 없음");
  expect(screen.queryByText("기본 공급자")).toBeNull();
  expect(screen.getByText(/전체 서비스의 정상 동작을 보장/)).toBeVisible();
  expect(read.mock.calls.slice(-3).map(([, options]) => options?.query)).toEqual([
    { window: "7d" },
    { window: "7d" },
    { window: "7d" },
  ]);
});
it.each(["hidden", "scope", "legacy", "rollout", "old-backend"])(
  "%s에서는 조회와 상세 이동 권한을 넓히지 않는다",
  async (kind) => {
    if (kind === "scope") state.auth = testAuth({ scopes: [] });
    if (kind === "old-backend") state.auth.backendVersion = "v0.86.128";
    if (["hidden", "legacy", "rollout"].includes(kind))
      state.auth.features = state.auth.features.map((f) =>
        ["governance.policies", "system.settings"].includes(f.featureId)
          ? {
              ...f,
              serverAvailable: undefined,
              status: kind === "hidden" ? "hidden" : kind === "legacy" ? "legacy" : "preview",
              rolloutPercent: kind === "rollout" ? 0 : 100,
            }
          : f,
      );
    setup();
    await act(async () => {});
    expect(read).not.toHaveBeenCalled();
    if (["hidden", "scope"].includes(kind))
      expect(screen.queryByRole("heading", { name: "주의 신호와 최근 작업" })).toBeNull();
    else expect(screen.getAllByText("요약 미제공")).toHaveLength(3);
  },
);
it("보안 조회 권한이 없으면 정책·알림 요약과 링크는 숨기고 관리 이력만 제공한다", async () => {
  state.auth = testAuth({ scopes: ["admin:read"] });
  setup();
  await screen.findByText("정책·승인");
  expect(read).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("heading", { name: "최근 알림" })).toBeNull();
  expect(screen.queryByRole("link", { name: "알림 기록 열기" })).toBeNull();
});
it.each([401, 403])("%s는 해당 데이터만 폐기하고 수동 재시도를 제공한다", async (code) => {
  setup();
  await screen.findByText("전송 오류", { exact: true });
  fail = code;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  await waitFor(() => expect(screen.queryByText("전송 오류", { exact: true })).toBeNull());
  expect(screen.getByText("기본 공급자")).toBeVisible();
  expect(screen.queryByText("private-error")).toBeNull();
  fail = 0;
  await userEvent.click(widget("최근 알림").getByRole("button", { name: /재시도/ }));
  await screen.findByText("전송 오류", { exact: true });
});
it("일시 실패는 마지막 정상 기록과 갱신 실패를 함께 보여준다", async () => {
  setup();
  await screen.findByText("전송 오류", { exact: true });
  fail = 503;
  await userEvent.click(screen.getByRole("button", { name: "전체 새로고침" }));
  await screen.findByText("새 갱신에 실패해 마지막 정상 데이터를 표시합니다.");
  expect(screen.getByText("전송 오류", { exact: true })).toBeVisible();
});
it("조회 주체가 바뀌면 이전 기록과 늦은 응답을 폐기한다", async () => {
  let resolve: (value: never) => void = () => undefined;
  read.mockImplementation(
    () =>
      new Promise<never>((done) => {
        resolve = done;
      }),
  );
  const view = setup();
  await waitFor(() => expect(read).toHaveBeenCalledTimes(3));
  state.auth = testAuth({ scopes: [] });
  view.refresh();
  await act(async () => resolve(auditActivity as never));
  expect(screen.queryByRole("heading", { name: "주의 신호와 최근 작업" })).toBeNull();
  expect(
    JSON.stringify(
      view.client
        .getQueryCache()
        .getAll()
        .map((q) => q.state.data),
    ),
  ).not.toContain("provider");
});
it("계약은 추가 원문 필드와 알 수 없는 작업·지표를 거부한다", () => {
  expect(alertActivitySchema.safeParse(alertActivity).success).toBe(true);
  expect(auditActivitySchema.safeParse(auditActivity).success).toBe(true);
  expect(incidentActivitySchema.safeParse(incidentActivity).success).toBe(true);
  expect(
    alertActivitySchema.safeParse({
      ...alertActivity,
      events: [{ ...alertActivity.events[0], delivery_error: "private" }],
    }).success,
  ).toBe(false);
  expect(
    auditActivitySchema.safeParse({
      ...auditActivity,
      changes: [{ ...auditActivity.changes[0], category: "private-value" }],
    }).success,
  ).toBe(false);
  expect(
    incidentActivitySchema.safeParse({
      ...incidentActivity,
      signals: [{ ...incidentActivity.signals[0], affected_users: 5 }],
    }).success,
  ).toBe(false);
});
